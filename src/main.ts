import { world, system, Entity, TicksPerSecond, EntityComponentTypes, MolangVariableMap } from "@minecraft/server";
import { MinecraftEntityTypes } from "vanilla-types/index";

// Configuration for collision box width generation
const COLLISION_BOX_CONFIG = {
  start: 0.16,        // Initial value
  min: 0.20,          // Start of generated sequence
  max: 13.0,          // End of generated sequence
  step: 0.01          // Increment step
};

/**
 * Generates the collision box widths array programmatically
 * Pattern: [start, min, min+step, min+2*step, ..., max]
 * @returns Array of collision box widths
 */
function generateCollisionBoxWidths(): number[] {
  const widths: number[] = [COLLISION_BOX_CONFIG.start];
  
  // Generate from min to max with step increment
  // Add small epsilon to max to ensure it's included despite floating point precision
  const maxWithEpsilon = COLLISION_BOX_CONFIG.max + (COLLISION_BOX_CONFIG.step / 2);
  
  for (let value = COLLISION_BOX_CONFIG.min; value <= maxWithEpsilon; value += COLLISION_BOX_CONFIG.step) {
    // Round to 2 decimal places to avoid floating point precision issues
    const rounded = Math.round(value * 100) / 100;
    widths.push(rounded);
  }
  
  return widths;
}

// Mapping of width values to compressed event indices (e0, e1, e2, etc.)
// Generated programmatically based on configuration
const COLLISION_BOX_WIDTHS = generateCollisionBoxWidths();

/**
 * Gets the compressed event name (e0, e1, e2, etc.) for a given collision box width
 * Uses O(1) calculation instead of O(n) array search for better performance
 * @param width - The collision box width value
 * @returns The compressed event name (e{index}) or null if no match found
 */
function getCompressedEventName(width: number): string | null {
  // Round to 2 decimal places for comparison
  const roundedWidth = Math.round(width * 100) / 100;
  
  // Check if it's the start value (0.16)
  if (Math.abs(roundedWidth - COLLISION_BOX_CONFIG.start) < 0.001) {
    return 'e0';
  }
  
  // Check if width is within the generated range
  if (roundedWidth < COLLISION_BOX_CONFIG.min || roundedWidth > COLLISION_BOX_CONFIG.max) {
    return null;
  }
  
  // Calculate index directly: start is at index 0, then min starts at index 1
  // Index = 1 + (width - min) / step
  const calculatedIndex = 1 + Math.round((roundedWidth - COLLISION_BOX_CONFIG.min) / COLLISION_BOX_CONFIG.step);
  
  // Validate index is within bounds
  if (calculatedIndex < 1 || calculatedIndex >= COLLISION_BOX_WIDTHS.length) {
    return null;
  }
  
  // Verify the calculated width matches (within tolerance for floating point)
  const calculatedWidth = COLLISION_BOX_CONFIG.min + (calculatedIndex - 1) * COLLISION_BOX_CONFIG.step;
  const roundedCalculatedWidth = Math.round(calculatedWidth * 100) / 100;
  
  if (Math.abs(roundedCalculatedWidth - roundedWidth) < 0.001) {
    return `e${calculatedIndex}`;
  }
  
  return null;
}

//Apply the damage to the owner entity when the collision box switcher is hurt.
world.afterEvents.entityHurt.subscribe((e) => {
  const entity = e.hurtEntity;
  if (entity.typeId !== "yn:collision_box_switcher") return;
  const ownerEntityID = entity.getDynamicProperty('collisionBoxOwnerEntityID') as number;
  if (!ownerEntityID) return;
  const ownerEntity = world.getEntity(ownerEntityID.toString()) as Entity;
  if (!ownerEntity) return;
  ownerEntity.applyDamage(e.damage, e.damageSource);
});

world.afterEvents.worldLoad.subscribe( () => {
  const job = system.runInterval(() => {
    try {
      for ( const player of world.getPlayers()) {
        const dimension = player.dimension;
  
        const entities = dimension.getEntities({excludeTypes: ["yn:collision_box_switcher", "minecraft:item"], families: ["mob"]});
  
        for ( const entity of entities) {
          const location = {x: Math.floor(entity.location.x), y: Math.floor(entity.location.y), z: Math.floor(entity.location.z)};
          const aabb = entity.getAABB();
          let width = aabb.extent.x * 2;
          let height = aabb.extent.y * 2;
        
          // Ignore if width is equal or below 0.0
          if (width <= 0.0) continue;
          
          const viewDirection = entity.getViewDirection();
          
          // Normalize view direction to only use X and Z (ignore Y)
          const horizontalMagnitude = Math.sqrt(viewDirection.x * viewDirection.x + viewDirection.z * viewDirection.z);
          const normalizedViewX = horizontalMagnitude > 0 ? viewDirection.x / horizontalMagnitude : 0;
          const normalizedViewZ = horizontalMagnitude > 0 ? viewDirection.z / horizontalMagnitude : 0;
          
          // Get the actual entity extents from AABB
          const extentX = aabb.extent.x;  // Half-width in X
          const extentZ = aabb.extent.z;  // Half-width in Z (depth)
          const entityCenter = entity.location;
          
          // Calculate perpendicular (right) vector by rotating normalized view direction 90 degrees
          const rightX = -normalizedViewZ;
          const rightZ = normalizedViewX;
          
          // Calculate the four corners of the entity's collision box
          // Front corners: center + (extentX * forward) ± (extentZ * right)
          // Back corners: center - (extentX * forward) ± (extentZ * right)
          const frontLeft = {
            x: entityCenter.x + (normalizedViewX * extentX) + (rightX * extentZ),
            y: entityCenter.y,
            z: entityCenter.z + (normalizedViewZ * extentX) + (rightZ * extentZ)
          };
          
          // Offset to shift backRight corner further towards the back
          // Adjust this value: 0.5 for half block, 1.0 for one block shift
          const backOffset = 1; // Change to 1.0 for 1 block shift
          
          const backRight = {
            x: entityCenter.x - (normalizedViewX * extentX) - (rightX * extentZ) - (normalizedViewX * backOffset),
            y: entityCenter.y,
            z: entityCenter.z - (normalizedViewZ * extentX) - (rightZ * extentZ) - (normalizedViewZ * backOffset)
          };
          
          // For particles: start = front-left corner, end = back-right corner (opposite corners)
          const startCorner = frontLeft;
          const endCorner = backRight;
          
          // Calculate detection volume as vector from startCorner to endCorner
          // Volume is the distance/direction vector, not absolute position
          const detectionLocation = {
            x: startCorner.x,
            y: location.y + 1.5,
            z: startCorner.z
          };
          
          const detectionVolume = {
            x: endCorner.x - startCorner.x,
            y: 5,
            z: endCorner.z - startCorner.z
          };

          const entitiesAbove = dimension.getEntities({
            excludeTypes: ["yn:collision_box_switcher"], 
            families: ["player"],
            location: detectionLocation,
            volume: detectionVolume
          }).filter((_entity) => _entity.typeId !== "yn:collision_box_switcher" && _entity.id !== entity.id && _entity.hasComponent(EntityComponentTypes.Movement));

          if(!entitiesAbove.length) {
            const solidCollisionEntityID = entity.getDynamicProperty("yn:collisionBoxEntityID") as number | null;
            if(!solidCollisionEntityID) continue;
            const solidCollisionEntity = world.getEntity(solidCollisionEntityID.toString()) as Entity;
            if(!solidCollisionEntity) continue;
            // If there's already a solid collision
            // Then, remove it, since there's no point for using the solid collision box, when there's no entity above.
            solidCollisionEntity.remove();
            entity.setDynamicProperty('yn:collisionBoxEntityID', null);
            console.warn('Removed solid collision box entity for entity:', entity.id);
          } 
          
          // There's an entity above.
          else {
            // If there's no solid collision box, then spawn one.
            const solidCollisionEntityID = entity.getDynamicProperty("yn:collisionBoxEntityID") as number | null;
            if(solidCollisionEntityID) continue;
          
            // Get compressed event name based on width
            const eventName = getCompressedEventName(width);
            if (!eventName) {
              continue;
            }
          
            // Summon collision box switcher entity
            let topPosition = {
              x: entity.location.x,
              y: entity.location.y + height,
              z: entity.location.z
            };
    
            const solidCollisionEntity = dimension.spawnEntity(
              "yn:collision_box_switcher",
              topPosition
            );

            solidCollisionEntity.triggerEvent(eventName);
            // Trigger the event with format <width>_<height>_set (using formatted strings to preserve 2 decimals)
            solidCollisionEntity.setDynamicProperty('collisionBoxOwnerEntityID', entity.id);
            solidCollisionEntity.setDynamicProperty('yn:lastExecutedTick', system.currentTick);
            entity.setDynamicProperty('yn:collisionBoxEntityID', solidCollisionEntity.id);
            entity.addTag('yn:solid_collision_box');
            console.warn('Spawned solid collision box entity for entity:', entity.id);
          }
        }
      }
    } catch (error) {
      console.error('Error in world load job:', error);
      system.clearRun(job);
      return;
    }
  }, 0.5)
});


// Spawning a mob with movement component should summon a solid collision box switcher entity.
world.afterEvents.entitySpawn.subscribe((spawnEvent) => {
  if (!spawnEvent) return;
  let entity = spawnEvent.entity;

  if (!entity || !entity.isValid) return;

  // For Stackable Mobs
  // For Testing the stackable. When interacting an entity it should summon
  // a stackable entity based on collision box size, if it is working for creating a solid mobs (new addon)
  if([
    "yn:collision_box_switcher",
    MinecraftEntityTypes.HappyGhast,
    MinecraftEntityTypes.Boat,
    MinecraftEntityTypes.Shulker,
  ].includes(entity?.typeId)) return;
  if(entity?.hasComponent(EntityComponentTypes.Movement)) {

    const aabb = entity.getAABB();
    let width = aabb.extent.x * 2;
    let height = aabb.extent.y * 2;
    const dimension = entity.dimension;
  
    // Ignore if width is equal or below 0.0
    if (width <= 0.0) return;
  
    // Format to 2 decimal places as strings (preserve trailing zeros for event name)
    const widthStr = width.toFixed(2);
    const heightStr = '0.05';
  
    // Summon collision box switcher entity
    let topPosition = {
      x: entity.location.x,
      y: entity.location.y + height,
      z: entity.location.z
    };

    // const collisionBoxEntity = dimension.spawnEntity(
    //   "yn:collision_box_switcher",
    //   topPosition
    // );
    
    // // Trigger the event with format <width>_<height>_set (using formatted strings to preserve 2 decimals)
    // const eventName = `${widthStr}_${heightStr}_set`;
    // collisionBoxEntity.triggerEvent(eventName);
    // collisionBoxEntity.setDynamicProperty('collisionBoxOwnerEntityID', entity.id);
    // collisionBoxEntity.setDynamicProperty('yn:lastExecutedTick', system.currentTick);
    // entity.setDynamicProperty('yn:collisionBoxEntityID', collisionBoxEntity.id);
    entity.addTag('yn:solid_collision_box');
    return;
  }
});

// Teleport as soon as this entity is loaded. This works even with reload command or reloadin world.
world.afterEvents.dataDrivenEntityTrigger.subscribe((e) => {
  const solidCollisionEntity = e.entity;
  if(!solidCollisionEntity?.isValid) return;
  if(solidCollisionEntity.typeId !== "yn:collision_box_switcher") return;

  const lastExecutedTick = solidCollisionEntity.getDynamicProperty("yn:lastExecutedTick") as number;
  if(!lastExecutedTick) return;
  const elapsedTicks = system.currentTick - lastExecutedTick;
  if(elapsedTicks > TicksPerSecond * 0.1) {

    // Execute every 0.1 seconds to teleport the solid collision entity to the owner entity.
    try {
      const ownerEntityID = solidCollisionEntity.getDynamicProperty('collisionBoxOwnerEntityID') as number;
      if (!ownerEntityID) {
        if(solidCollisionEntity?.isValid) {
          solidCollisionEntity.remove();
        }
        return;
      }
      const ownerEntity = world.getEntity(ownerEntityID.toString()) as Entity;
      if (!ownerEntity) {
        if(solidCollisionEntity?.isValid) {
          solidCollisionEntity.remove();
          ownerEntity.setDynamicProperty('yn:collisionBoxEntityID', null);
        }
        return;
      }
      const aabb = ownerEntity.getAABB();
      let width = aabb.extent.x * 2;
      let height = aabb.extent.y * 2;

      const isDone = !ownerEntity.isValid || !solidCollisionEntity.isValid;
      if(isDone) {
        if(solidCollisionEntity?.isValid) {
          solidCollisionEntity.remove();
          ownerEntity.setDynamicProperty('yn:collisionBoxEntityID', null);
        }
        return;
      }

      let topPosition = {
        x: ownerEntity.location.x,
        y: (ownerEntity.location.y + height),
        z: ownerEntity.location.z
      };
      solidCollisionEntity.teleport(topPosition, {
        dimension: ownerEntity.dimension,
        rotation: ownerEntity.getRotation()
      });
      solidCollisionEntity.setDynamicProperty('yn:lastExecutedTick', system.currentTick);
    } catch (e) {
      // console.error('Error teleporting solid collision entity to the owner entity.', e);
      if(solidCollisionEntity?.isValid) solidCollisionEntity.remove();
    }
  }
});