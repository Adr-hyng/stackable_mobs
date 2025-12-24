import { world, system, Entity, TicksPerSecond, EntityComponentTypes, MolangVariableMap } from "@minecraft/server";
import { MinecraftEntityTypes } from "vanilla-types/index";
import { runJobAsync } from "./runJobAsync";
import { Vec3 } from "VectorUtils";

// Configuration for collision box width generation
const COLLISION_BOX_CONFIG = {
  start: 0.16,        // Initial value
  min: 0.20,          // Start of generated sequence
  max: 13.0,          // End of generated sequence
  step: 0.01          // Increment step
};

// Cache for the generated collision box widths array
let COLLISION_BOX_WIDTHS_CACHE: number[] | null = null;

/**
 * Generates the collision box widths array programmatically
 * Pattern: [start, min, min+step, ..., 4.0, 4.02, 13.0]
 * Note: 4.01 is skipped to match the original array structure
 * Uses caching to ensure the array is only generated once
 * @returns Array of collision box widths
 */
function generateCollisionBoxWidths(): number[] {
  // Return cached array if already generated
  if (COLLISION_BOX_WIDTHS_CACHE !== null) {
    return COLLISION_BOX_WIDTHS_CACHE;
  }
  
  const widths: number[] = [COLLISION_BOX_CONFIG.start];
  
  // Generate from min (0.20) to 4.0 with step increment
  const firstSegmentEnd = 4.0;
  const maxWithEpsilon = firstSegmentEnd + (COLLISION_BOX_CONFIG.step / 2);
  
  for (let value = COLLISION_BOX_CONFIG.min; value <= maxWithEpsilon; value += COLLISION_BOX_CONFIG.step) {
    // Round to 2 decimal places to avoid floating point precision issues
    const rounded = Math.round(value * 100) / 100;
    // Stop at 4.0 (don't include 4.01)
    if (rounded > firstSegmentEnd + 0.001) break;
    widths.push(rounded);
  }
  
  // Add 4.02 (skipping 4.01)
  widths.push(4.02);
  
  // Add 13.0 at the end
  widths.push(13.0);
  
  // Cache the result
  COLLISION_BOX_WIDTHS_CACHE = widths;
  
  return widths;
}

// Mapping of width values to compressed event indices (e0, e1, e2, etc.)
// Generated programmatically based on configuration (cached after first generation)
const COLLISION_BOX_WIDTHS = generateCollisionBoxWidths();

/**
 * Gets the compressed event name (e0, e1, e2, etc.) for a given collision box width
 * Uses O(1) calculation instead of O(n) array search for better performance
 * Handles the special case where 4.01 is skipped (goes from 4.0 to 4.02 to 13.0)
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
  if (roundedWidth < COLLISION_BOX_CONFIG.min || roundedWidth > 13.0) {
    return null;
  }
  
  let calculatedIndex: number;
  
  // Handle the three segments: 0.20-4.0 (continuous), 4.02, 13.0
  if (roundedWidth <= 4.0) {
    // Continuous segment from 0.20 to 4.0
    calculatedIndex = 1 + Math.round((roundedWidth - COLLISION_BOX_CONFIG.min) / COLLISION_BOX_CONFIG.step);
  } else if (Math.abs(roundedWidth - 4.02) < 0.001) {
    // 4.02 is right after 4.0 (skipping 4.01)
    // Index of 4.0 = 1 + (4.0 - 0.20) / 0.01 = 1 + 380 = 381
    // So 4.02 is at index 382
    calculatedIndex = 382;
  } else if (Math.abs(roundedWidth - 13.0) < 0.001) {
    // 13.0 is at the end (index 383)
    calculatedIndex = 383;
  } else {
    // Values between 4.02 and 13.0 (excluding 13.0) don't exist
    return null;
  }
  
  // Validate index is within bounds
  if (calculatedIndex < 1 || calculatedIndex >= COLLISION_BOX_WIDTHS.length) {
    return null;
  }
  
  // Verify the width at this index matches (use actual array value for accuracy)
  const actualWidth = COLLISION_BOX_WIDTHS[calculatedIndex];
  if (Math.abs(actualWidth - roundedWidth) < 0.001) {
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
  // Process entities in batches to distribute load across ticks
  const processEntities = function*(resolve: () => void, jobRef: { job: number }) {
    try {
      const players = world.getPlayers();
      
      for (const player of players) {
        const dimension = player.dimension;
        const entities = dimension.getEntities({excludeTypes: ["yn:collision_box_switcher", "minecraft:item"], families: ["mob"]});
        
        for (const entity of entities) {
          // const location = {x: Math.floor(entity.location.x), y: Math.floor(entity.location.y), z: Math.floor(entity.location.z)};
          const aabb = entity.getAABB();
          let width = aabb.extent.x * 2;
          let height = aabb.extent.y * 2;
        
          // Ignore if width is equal or below 0.0
          if (width <= 0.0) {
            yield; // Yield after each entity check to distribute load
            continue;
          }
          
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
            y: startCorner.y + (height / 2),
            z: startCorner.z
          };
          
          const detectionVolume = {
            x: endCorner.x - startCorner.x,
            y: 5,
            z: endCorner.z - startCorner.z
          };

          yield;
          const entitiesAbove = dimension.getEntities({
            excludeTypes: ["yn:collision_box_switcher"], 
            families: ["player"],
            location: detectionLocation,
            volume: detectionVolume
          }).filter((_entity) => _entity.typeId !== "yn:collision_box_switcher" && _entity.id !== entity.id && _entity.hasComponent(EntityComponentTypes.Movement));

          if(!entitiesAbove.length) {
            const solidCollisionEntityID = entity.getDynamicProperty("yn:collisionBoxEntityID") as number | null;
            if(!solidCollisionEntityID) {
              // Clear the no entities above timestamp if it exists
              entity.setDynamicProperty('yn:noEntitiesAboveTick', null);
              yield; // Yield after each entity check to distribute load
              continue;
            }
            const solidCollisionEntity = world.getEntity(solidCollisionEntityID.toString()) as Entity;
            if(!solidCollisionEntity) {
              // Clear the no entities above timestamp if it exists
              entity.setDynamicProperty('yn:noEntitiesAboveTick', null);
              yield; // Yield after each entity check to distribute load
              continue;
            }
            
            // Check if we've already started the delay timer
            const noEntitiesAboveTick = entity.getDynamicProperty("yn:noEntitiesAboveTick") as number | null;
            const currentTick = system.currentTick;
            
            if (noEntitiesAboveTick === null) {
              // First time detecting no entities above - start the timer
              entity.setDynamicProperty('yn:noEntitiesAboveTick', currentTick);
              yield; // Yield after each entity check to distribute load
              continue;
            }
            
            // Safety check: if stored tick is invalid or in the future, reset it
            if (noEntitiesAboveTick > currentTick) {
              entity.setDynamicProperty('yn:noEntitiesAboveTick', currentTick);
              yield; // Yield after each entity check to distribute load
              continue;
            }
            
            // Check if 20 ticks (1 second at 20 TPS) have passed since first detection
            const elapsedTicks = currentTick - noEntitiesAboveTick;
            const requiredTicks = TicksPerSecond; // 20 ticks = 1 second
            
            if (elapsedTicks < requiredTicks) {
              // Not enough time has passed, wait more
              yield; // Yield after each entity check to distribute load
              continue;
            }
            
            // 1 second has passed, now remove the collision box entity
            solidCollisionEntity.remove();
            entity.setDynamicProperty('yn:collisionBoxEntityID', null);
            entity.setDynamicProperty('yn:noEntitiesAboveTick', null);
            console.warn('Removed solid collision box entity for entity:', entity.id, 'after', elapsedTicks, 'ticks');
          } 
          
          // There's an entity above.
          else {
            // Clear the no entities above timestamp since entities are now above
            entity.setDynamicProperty('yn:noEntitiesAboveTick', null);
            
            // Debug
            const particle = new MolangVariableMap();
            dimension.spawnParticle("minecraft:villager_happy", {
              x: detectionLocation.x,
              y: detectionLocation.y,
              z: detectionLocation.z
            }, particle);
            dimension.spawnParticle("minecraft:villager_happy", {
              x: detectionLocation.x + detectionVolume.x,
              y: detectionLocation.y + detectionVolume.y,
              z: detectionLocation.z + detectionVolume.z
            }, particle);

            // If there's no solid collision box, then spawn one.
            const solidCollisionEntityID = entity.getDynamicProperty("yn:collisionBoxEntityID") as number | null;
            if(solidCollisionEntityID) {
              yield; // Yield after each entity check to distribute load
              continue;
            }
          
            // Get compressed event name based on width
            const eventName = getCompressedEventName(width);
            if (!eventName) {
              yield; // Yield after each entity check to distribute load
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
            console.warn('Triggered event:', eventName, width, height);
            // Trigger the event with format <width>_<height>_set (using formatted strings to preserve 2 decimals)
            solidCollisionEntity.setDynamicProperty('collisionBoxOwnerEntityID', entity.id);
            solidCollisionEntity.setDynamicProperty('yn:lastExecutedTick', system.currentTick);
            entity.setDynamicProperty('yn:collisionBoxEntityID', solidCollisionEntity.id);
            entity.addTag('yn:solid_collision_box');
            console.warn('Spawned solid collision box entity for entity:', entity.id);
          }
          
          yield; // Yield after processing each entity to distribute load across ticks
        }
      }
    } catch (error) {
      console.error('Error in world load job:', error);
    }
    
    // Schedule next run after 0.5 seconds (10 ticks at 20 TPS)
    system.runTimeout(async () => {
      await runJobAsync(processEntities);
      system.clearJob(jobRef.job);
      resolve();
    }, 1);
    
  };
  
  // Start the async job
  runJobAsync(processEntities);
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
    // Ignore if width is equal or below 0.0
    if (width <= 0.0) return;
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