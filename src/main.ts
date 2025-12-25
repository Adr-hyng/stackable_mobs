import { world, system, Entity, TicksPerSecond, EntityComponentTypes, AABB } from "@minecraft/server";
import { MinecraftEntityTypes } from "vanilla-types/index";
import { runJobAsync } from "./runJobAsync";

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
  if (entity.typeId === "yn:collision_box_switcher") {
    const ownerEntityID = entity.getDynamicProperty('collisionBoxOwnerEntityID') as number;
    if (!ownerEntityID) return;
    const ownerEntity = world.getEntity(ownerEntityID.toString()) as Entity;
    if (!ownerEntity) return;
    ownerEntity.applyDamage(e.damage, e.damageSource);
  }
});

world.afterEvents.entityDie.subscribe((e) => {
  const entity = e.deadEntity;
  if (!entity || !entity.isValid) return;
  if (entity.typeId === "yn:collision_box_switcher") return;
  const solidCollisionEntityID = entity.getDynamicProperty('yn:collisionBoxEntityID') as number;
  if (!solidCollisionEntityID) return;
  const solidCollisionEntity = world.getEntity(solidCollisionEntityID.toString()) as Entity;
  if (!solidCollisionEntity) return;
  solidCollisionEntity.remove();
});


world.afterEvents.worldLoad.subscribe( async () => {
  // Counter for all collision box switcher entities spawned from worldLoad
  let collisionBoxSwitcherSpawnCount = 0;
  // Process entities in batches to distribute load across ticks
  const processEntities = function*(resolve: () => void, jobRef: { job: number }) {
    // Use a while loop instead of recursion
    let shouldContinue = true;
    
    while (shouldContinue) {
      try {
        const players = world.getPlayers();
        
        for (const player of players) {
          try {
            const dimension = player.dimension;
            const entities = dimension.getEntities({excludeTypes: ["yn:collision_box_switcher", "minecraft:item"], families: ["mob"]});
            yield;
            // Optimize yield frequency based on entity count
            const entityCount = entities.length;
            const yieldFrequency = entityCount > 50 ? 1 : 5; // Yield every entity if many, every 5 if few
            let entityProcessedCount = 0;
            
            for (const entity of entities) {
              try {
                if(!entity || !entity.isValid) continue;
                
                // Early tag check: Cache collision box entity ID early for later use
                const solidCollisionEntityID = entity.getDynamicProperty("yn:collisionBoxEntityID") as number | null;
                // Early exit: Skip entities without tag and without collision box ID (they don't need processing)
                // However, we still need to check for entities above to potentially spawn one, so we continue
                // but this early check helps us know the state early
                
                // Safely get AABB with error handling
                let aabb: AABB | null = null;
                try {
                  aabb = entity.getAABB();
                } catch (error) {
                  // Entity might be invalid or in an invalid state, skip it
                  continue;
                }
                
                if(!aabb) continue;
                let width = aabb.extent.x * 2;
                let height = aabb.extent.y * 2;
              
                // Ignore if width is equal or below 0.0
                if (width <= 0.0) {
                  continue;
                }
                
                // Cache entity location to avoid multiple property accesses
                const entityLocation = entity.location;
                
                // Safely get view direction
                let viewDirection;
                try {
                  viewDirection = entity.getViewDirection();
                } catch (error) {
                  // Entity might not have view direction, skip it
                  continue;
                }
          
                // Normalize view direction to only use X and Z (ignore Y)
                // Cache Math.sqrt calculation
                const horizontalMagnitudeSq = viewDirection.x * viewDirection.x + viewDirection.z * viewDirection.z;
                const horizontalMagnitude = Math.sqrt(horizontalMagnitudeSq);
                const normalizedViewX = horizontalMagnitude > 0 ? viewDirection.x / horizontalMagnitude : 0;
                const normalizedViewZ = horizontalMagnitude > 0 ? viewDirection.z / horizontalMagnitude : 0;
                
                // Get the actual entity extents from AABB
                const extentX = aabb.extent.x;  // Half-width in X
                const extentZ = aabb.extent.z;  // Half-width in Z (depth)
                const entityCenter = entityLocation; // Use cached location
          
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
          const backOffset = 0.5; // Change to 1.0 for 1 block shift
          
          const backRight = {
            x: entityCenter.x - (normalizedViewX * extentX) - (rightX * extentZ) - (normalizedViewX * backOffset),
            y: entityCenter.y,
            z: entityCenter.z - (normalizedViewZ * extentX) - (rightZ * extentZ) - (normalizedViewZ * backOffset)
          };
          
          // For particles: start = front-left corner, end = back-right corner (opposite corners)
          const startCorner = frontLeft;
          const endCorner = backRight;
          
          // Calculate detection volume with proper bounds
          // Use min/max to ensure we get the correct bounding box
          // The volume must be absolute positive values representing the bounding box size
          const minX = Math.min(startCorner.x, endCorner.x);
          const maxX = Math.max(startCorner.x, endCorner.x);
          const minZ = Math.min(startCorner.z, endCorner.z);
          const maxZ = Math.max(startCorner.z, endCorner.z);
          
          const detectionLocation = {
            x: minX,
            y: startCorner.y + height + 1, // Start at entity top
            z: minZ
          };
          
          const detectionVolume = {
            x: maxX - minX,
            y: height + (width / 2), // Increased slightly to catch edge cases
            z: maxZ - minZ
          };
                let entitiesAbove: Entity[] = [];

                // Check for 1st priority, check for jumping nearby entity
                try {
                  entitiesAbove = dimension.getEntities({
                    excludeTypes: ["yn:collision_box_switcher", "minecraft:item"], 
                    families: ["player"],
                    closest: 1,
                    location: entityLocation, // Use cached location
                    maxDistance: width * 2,
                  }).filter((_entity) => _entity.id !== entity.id && _entity.hasComponent(EntityComponentTypes.Movement));
                } catch (error) {
                  // If getEntities fails, continue to next entity
                  continue;
                }

                if(!entitiesAbove.length) {
                  // Check for 2nd prioirity
                  try {
                    entitiesAbove = dimension.getEntities({
                      excludeTypes: ["yn:collision_box_switcher", "minecraft:item"], 
                      location: detectionLocation,
                      volume: detectionVolume
                    }).filter((_entity) => _entity.id !== entity.id && _entity.hasComponent(EntityComponentTypes.Movement) && !_entity.hasComponent(EntityComponentTypes.NavigationFloat));
                  } catch (error) {
                    // If getEntities fails, continue to next entity
                    continue;
                  }
                }

                if(!entitiesAbove.length) {
                  // Use already retrieved solidCollisionEntityID from early check
                  if(!solidCollisionEntityID) {
                    // Clear the no entities above timestamp if it exists
                    entity.setDynamicProperty('yn:noEntitiesAboveTick', null);
                    continue;
                  }
                  const solidCollisionEntity = world.getEntity(solidCollisionEntityID.toString()) as Entity;
                  if(!solidCollisionEntity) {
                    // Clear the no entities above timestamp if it exists
                    entity.setDynamicProperty('yn:noEntitiesAboveTick', null);
                    continue;
                  }
                  
                  // Check if we've already started the delay timer
                  const noEntitiesAboveTickRaw = entity.getDynamicProperty("yn:noEntitiesAboveTick");
                  const noEntitiesAboveTick = (typeof noEntitiesAboveTickRaw === 'number') ? noEntitiesAboveTickRaw : null;
                  const currentTick = system.currentTick;
                  
                  if (noEntitiesAboveTick === null || noEntitiesAboveTick === undefined) {
                    // First time detecting no entities above - start the timer
                    entity.setDynamicProperty('yn:noEntitiesAboveTick', currentTick);
                    continue;
                  }
                  
                  // Safety check: if stored tick is invalid or in the future, reset it
                  if (typeof noEntitiesAboveTick !== 'number' || noEntitiesAboveTick > currentTick) {
                    entity.setDynamicProperty('yn:noEntitiesAboveTick', currentTick);
                    continue;
                  }
                  
                  // Check if 19 ticks (1 tick short of 1 second) have passed since first detection
                  // This allows instant detection when an entity appears above
                  const elapsedTicks = currentTick - noEntitiesAboveTick;
                  const requiredTicks = TicksPerSecond / 2; // 19 ticks = 0.95 seconds
                  
                  if (elapsedTicks < requiredTicks) {
                    // Not enough time has passed, wait more
                    continue;
                  }
                  
                  // 1 second has passed, now remove the collision box entity
                  solidCollisionEntity.remove();
                  // Decrement the spawn counter
                  collisionBoxSwitcherSpawnCount--;
                  entity.setDynamicProperty('yn:collisionBoxEntityID', null);
                  entity.setDynamicProperty('yn:noEntitiesAboveTick', null);
                  // console.warn('Removed solid collision box entity for entity:', entity.id, 'after', elapsedTicks, 'ticks');
                  // console.warn('Total spawned:', collisionBoxSwitcherSpawnCount);
                } 
                
                // There's an entity above.
                else {
                  // Clear the no entities above timestamp since entities are now above
                  entity.setDynamicProperty('yn:noEntitiesAboveTick', null);
                  
                  // Debug
                  // const particle = new MolangVariableMap();
                  // dimension.spawnParticle("minecraft:villager_happy", {
                  //   x: detectionLocation.x,
                  //   y: detectionLocation.y,
                  //   z: detectionLocation.z
                  // }, particle);
                  // dimension.spawnParticle("minecraft:villager_happy", {
                  //   x: detectionLocation.x + detectionVolume.x,
                  //   y: detectionLocation.y + detectionVolume.y,
                  //   z: detectionLocation.z + detectionVolume.z
                  // }, particle);

                  // If there's no solid collision box, then spawn one.
                  // Use already retrieved solidCollisionEntityID from early check
                  if(solidCollisionEntityID) {
                    continue;
                  }
                
                  // Get compressed event name based on width
                  const eventName = getCompressedEventName(width);
                  if (!eventName) {
                    continue;
                  }
                
                  // Calculate the block location (floor coordinates) where the collision box will be
                  // Use cached entity location
                  const topPosition = {
                    x: entityLocation.x,
                    y: entityLocation.y + height,
                    z: entityLocation.z
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
                  
                  // Increment the spawn counter
                  collisionBoxSwitcherSpawnCount++;
                }
              } catch (error) {
                // Log error but continue processing other entities
                console.error('Error processing entity:', entity?.id, error);
                continue;
              }
              
              entityProcessedCount++;
              // Optimize yield frequency: yield every N entities based on total count
              if (entityProcessedCount % yieldFrequency === 0) {
                yield;
              }
            }
          } catch (error) {
            // Log error but continue processing other players
            console.error('Error processing player dimension:', error);
            continue;
          }
        }
        
        // Wait 10 ticks (0.5 seconds) before next iteration
        for (let i = 0; i < 5; i++) {
          yield;
        }
      } catch (error) {
        // Log error but continue the while loop
        console.error('Error in processEntities loop:', error);
        // Wait a bit before retrying
        for (let i = 0; i < 3; i++) {
          yield;
        }
      }
    }
    
    system.clearJob(jobRef.job);
    resolve();
  };
  
  // Start the async job
  await runJobAsync(processEntities);
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
      // console.warn('Error teleporting solid collision entity to the owner entity.', e);
      if(solidCollisionEntity?.isValid) solidCollisionEntity.remove();
    }
  }
});