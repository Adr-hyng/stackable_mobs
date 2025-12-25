import { world, system, TicksPerSecond, EntityComponentTypes } from "@minecraft/server";
import { MinecraftEntityTypes } from "vanilla-types/index";
import { runJobAsync } from "./runJobAsync";
const COLLISION_BOX_CONFIG = {
    start: 0.16,
    min: 0.20,
    max: 13.0,
    step: 0.01
};
let COLLISION_BOX_WIDTHS_CACHE = null;
function generateCollisionBoxWidths() {
    if (COLLISION_BOX_WIDTHS_CACHE !== null) {
        return COLLISION_BOX_WIDTHS_CACHE;
    }
    const widths = [COLLISION_BOX_CONFIG.start];
    const firstSegmentEnd = 4.0;
    const maxWithEpsilon = firstSegmentEnd + (COLLISION_BOX_CONFIG.step / 2);
    for (let value = COLLISION_BOX_CONFIG.min; value <= maxWithEpsilon; value += COLLISION_BOX_CONFIG.step) {
        const rounded = Math.round(value * 100) / 100;
        if (rounded > firstSegmentEnd + 0.001)
            break;
        widths.push(rounded);
    }
    widths.push(4.02);
    widths.push(13.0);
    COLLISION_BOX_WIDTHS_CACHE = widths;
    return widths;
}
const COLLISION_BOX_WIDTHS = generateCollisionBoxWidths();
function getCompressedEventName(width) {
    const roundedWidth = Math.round(width * 100) / 100;
    if (Math.abs(roundedWidth - COLLISION_BOX_CONFIG.start) < 0.001) {
        return 'e0';
    }
    if (roundedWidth < COLLISION_BOX_CONFIG.min || roundedWidth > 13.0) {
        return null;
    }
    let calculatedIndex;
    if (roundedWidth <= 4.0) {
        calculatedIndex = 1 + Math.round((roundedWidth - COLLISION_BOX_CONFIG.min) / COLLISION_BOX_CONFIG.step);
    }
    else if (Math.abs(roundedWidth - 4.02) < 0.001) {
        calculatedIndex = 382;
    }
    else if (Math.abs(roundedWidth - 13.0) < 0.001) {
        calculatedIndex = 383;
    }
    else {
        return null;
    }
    if (calculatedIndex < 1 || calculatedIndex >= COLLISION_BOX_WIDTHS.length) {
        return null;
    }
    const actualWidth = COLLISION_BOX_WIDTHS[calculatedIndex];
    if (Math.abs(actualWidth - roundedWidth) < 0.001) {
        return `e${calculatedIndex}`;
    }
    return null;
}
world.afterEvents.entityHurt.subscribe((e) => {
    const entity = e.hurtEntity;
    if (entity.typeId !== "yn:collision_box_switcher")
        return;
    const ownerEntityID = entity.getDynamicProperty('collisionBoxOwnerEntityID');
    if (!ownerEntityID)
        return;
    const ownerEntity = world.getEntity(ownerEntityID.toString());
    if (!ownerEntity)
        return;
    ownerEntity.applyDamage(e.damage, e.damageSource);
});
world.afterEvents.worldLoad.subscribe(async () => {
    const processEntities = function* (resolve, jobRef) {
        try {
            const players = world.getPlayers();
            for (const player of players) {
                const dimension = player.dimension;
                const entities = dimension.getEntities({ excludeTypes: ["yn:collision_box_switcher", "minecraft:item"], families: ["mob"] });
                for (const entity of entities) {
                    const aabb = entity.getAABB();
                    let width = aabb.extent.x * 2;
                    let height = aabb.extent.y * 2;
                    yield;
                    if (width <= 0.0) {
                        continue;
                    }
                    const viewDirection = entity.getViewDirection();
                    const horizontalMagnitude = Math.sqrt(viewDirection.x * viewDirection.x + viewDirection.z * viewDirection.z);
                    const normalizedViewX = horizontalMagnitude > 0 ? viewDirection.x / horizontalMagnitude : 0;
                    const normalizedViewZ = horizontalMagnitude > 0 ? viewDirection.z / horizontalMagnitude : 0;
                    const extentX = aabb.extent.x;
                    const extentZ = aabb.extent.z;
                    const entityCenter = entity.location;
                    const rightX = -normalizedViewZ;
                    const rightZ = normalizedViewX;
                    const frontLeft = {
                        x: entityCenter.x + (normalizedViewX * extentX) + (rightX * extentZ),
                        y: entityCenter.y,
                        z: entityCenter.z + (normalizedViewZ * extentX) + (rightZ * extentZ)
                    };
                    const backOffset = 0.5;
                    const backRight = {
                        x: entityCenter.x - (normalizedViewX * extentX) - (rightX * extentZ) - (normalizedViewX * backOffset),
                        y: entityCenter.y,
                        z: entityCenter.z - (normalizedViewZ * extentX) - (rightZ * extentZ) - (normalizedViewZ * backOffset)
                    };
                    const startCorner = frontLeft;
                    const endCorner = backRight;
                    const minX = Math.min(startCorner.x, endCorner.x);
                    const maxX = Math.max(startCorner.x, endCorner.x);
                    const minZ = Math.min(startCorner.z, endCorner.z);
                    const maxZ = Math.max(startCorner.z, endCorner.z);
                    const detectionLocation = {
                        x: minX,
                        y: startCorner.y + height,
                        z: minZ
                    };
                    const detectionVolume = {
                        x: maxX - minX,
                        y: height + 1,
                        z: maxZ - minZ
                    };
                    let entitiesAbove = [];
                    entitiesAbove = dimension.getEntities({
                        excludeTypes: ["yn:collision_box_switcher"],
                        families: ["player"],
                        closest: 1,
                        maxDistance: width + 1,
                    }).filter((_entity) => _entity.typeId !== "yn:collision_box_switcher" && _entity.id !== entity.id && _entity.hasComponent(EntityComponentTypes.Movement) && _entity.isFalling);
                    if (!entitiesAbove.length) {
                        entitiesAbove = dimension.getEntities({
                            excludeTypes: ["yn:collision_box_switcher"],
                            families: ["player"],
                            location: detectionLocation,
                            volume: detectionVolume
                        }).filter((_entity) => _entity.typeId !== "yn:collision_box_switcher" && _entity.id !== entity.id && _entity.hasComponent(EntityComponentTypes.Movement));
                    }
                    if (!entitiesAbove.length) {
                        const solidCollisionEntityID = entity.getDynamicProperty("yn:collisionBoxEntityID");
                        if (!solidCollisionEntityID) {
                            entity.setDynamicProperty('yn:noEntitiesAboveTick', null);
                            continue;
                        }
                        const solidCollisionEntity = world.getEntity(solidCollisionEntityID.toString());
                        if (!solidCollisionEntity) {
                            entity.setDynamicProperty('yn:noEntitiesAboveTick', null);
                            continue;
                        }
                        const noEntitiesAboveTickRaw = entity.getDynamicProperty("yn:noEntitiesAboveTick");
                        const noEntitiesAboveTick = (typeof noEntitiesAboveTickRaw === 'number') ? noEntitiesAboveTickRaw : null;
                        const currentTick = system.currentTick;
                        if (noEntitiesAboveTick === null || noEntitiesAboveTick === undefined) {
                            entity.setDynamicProperty('yn:noEntitiesAboveTick', currentTick);
                            continue;
                        }
                        if (typeof noEntitiesAboveTick !== 'number' || noEntitiesAboveTick > currentTick) {
                            entity.setDynamicProperty('yn:noEntitiesAboveTick', currentTick);
                            continue;
                        }
                        const elapsedTicks = currentTick - noEntitiesAboveTick;
                        const requiredTicks = TicksPerSecond - 1;
                        if (elapsedTicks < requiredTicks) {
                            continue;
                        }
                        solidCollisionEntity.remove();
                        entity.setDynamicProperty('yn:collisionBoxEntityID', null);
                        entity.setDynamicProperty('yn:noEntitiesAboveTick', null);
                        console.warn('Removed solid collision box entity for entity:', entity.id, 'after', elapsedTicks, 'ticks');
                    }
                    else {
                        entity.setDynamicProperty('yn:noEntitiesAboveTick', null);
                        const solidCollisionEntityID = entity.getDynamicProperty("yn:collisionBoxEntityID");
                        if (solidCollisionEntityID) {
                            continue;
                        }
                        const eventName = getCompressedEventName(width);
                        if (!eventName) {
                            continue;
                        }
                        let topPosition = {
                            x: entity.location.x,
                            y: entity.location.y + height,
                            z: entity.location.z
                        };
                        const solidCollisionEntity = dimension.spawnEntity("yn:collision_box_switcher", topPosition);
                        solidCollisionEntity.triggerEvent(eventName);
                        solidCollisionEntity.setDynamicProperty('collisionBoxOwnerEntityID', entity.id);
                        solidCollisionEntity.setDynamicProperty('yn:lastExecutedTick', system.currentTick);
                        entity.setDynamicProperty('yn:collisionBoxEntityID', solidCollisionEntity.id);
                        entity.addTag('yn:solid_collision_box');
                        console.warn('Spawned solid collision box entity for entity:', entity.id);
                    }
                    yield;
                }
            }
        }
        catch (error) {
            console.error('Error in world load job:', error);
        }
        system.run(async () => {
            await runJobAsync(processEntities);
            system.clearJob(jobRef.job);
            resolve();
        });
    };
    await runJobAsync(processEntities);
});
world.afterEvents.entitySpawn.subscribe((spawnEvent) => {
    if (!spawnEvent)
        return;
    let entity = spawnEvent.entity;
    if (!entity || !entity.isValid)
        return;
    if ([
        "yn:collision_box_switcher",
        MinecraftEntityTypes.HappyGhast,
        MinecraftEntityTypes.Boat,
        MinecraftEntityTypes.Shulker,
    ].includes(entity?.typeId))
        return;
    if (entity?.hasComponent(EntityComponentTypes.Movement)) {
        const aabb = entity.getAABB();
        let width = aabb.extent.x * 2;
        if (width <= 0.0)
            return;
        entity.addTag('yn:solid_collision_box');
        return;
    }
});
world.afterEvents.dataDrivenEntityTrigger.subscribe((e) => {
    const solidCollisionEntity = e.entity;
    if (!solidCollisionEntity?.isValid)
        return;
    if (solidCollisionEntity.typeId !== "yn:collision_box_switcher")
        return;
    const lastExecutedTick = solidCollisionEntity.getDynamicProperty("yn:lastExecutedTick");
    if (!lastExecutedTick)
        return;
    const elapsedTicks = system.currentTick - lastExecutedTick;
    if (elapsedTicks > TicksPerSecond * 0.1) {
        try {
            const ownerEntityID = solidCollisionEntity.getDynamicProperty('collisionBoxOwnerEntityID');
            if (!ownerEntityID) {
                if (solidCollisionEntity?.isValid) {
                    solidCollisionEntity.remove();
                }
                return;
            }
            const ownerEntity = world.getEntity(ownerEntityID.toString());
            if (!ownerEntity) {
                if (solidCollisionEntity?.isValid) {
                    solidCollisionEntity.remove();
                    ownerEntity.setDynamicProperty('yn:collisionBoxEntityID', null);
                }
                return;
            }
            const aabb = ownerEntity.getAABB();
            let width = aabb.extent.x * 2;
            let height = aabb.extent.y * 2;
            const isDone = !ownerEntity.isValid || !solidCollisionEntity.isValid;
            if (isDone) {
                if (solidCollisionEntity?.isValid) {
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
        }
        catch (e) {
            if (solidCollisionEntity?.isValid)
                solidCollisionEntity.remove();
        }
    }
});
