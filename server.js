import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';

const wss = new WebSocketServer({ port: 8080 });
console.log('WebSocket Server gestartet auf Port 8080');

// --- Waffen Definitionen (Serverseitig für Schadensberechnung etc.) ---
const WEAPON_DATA = {
    'P2020': { name: 'P2020', damage: 18, fireRate: 330, type: 'pistol', ammo: 12, hitsToKill: Math.ceil(100/18), soundId: 'p2020' },
    'R99': { name: 'R-99 SMG', damage: 11, fireRate: 90, type: 'smg', ammo: 20, hitsToKill: Math.ceil(100/11), soundId: 'r99' },
    'Flatline': { name: 'VK-47 Flatline', damage: 19, fireRate: 580, type: 'rifle', ammo: 20, hitsToKill: Math.ceil(100/19), soundId: 'flatline' },
    'Sentinel': { name: 'Sentinel', damage: 70, fireRate: 1250, type: 'sniper', ammo: 4, hitsToKill: Math.ceil(100/70), soundId: 'sentinel' },
};
const DEFAULT_WEAPON = 'P2020';


const players = {};
const gameSettings = {
    gravity: -30, playerSpeed: 10, playerSprintSpeed: 15, playerCrouchSpeed: 5,
    jumpVelocity: 12, slideBoost: 18, slideDuration: 600, wallJumpBoost: 15,
    wallStickTime: 250, maxHealth: 100,
    worldBounds: { x: 60, z: 60, y_min: -20 }, // Etwas größere Welt
    respawnHeight: 5, maxRayDistance: 250,
    stepSoundInterval: 350, 
};

const playerDimensions = {
    height: 1.8, crouchHeight: 1.0, width: 0.5, eyeHeightFactor: 0.9,
};

// --- Weltobjekte / Gebäude ---
const worldObjects = [
    // Ein einfaches Gebäude
    { id: 'b1_wall_n', type: 'box', position: { x: 0, y: 0, z: -15 }, size: { x: 20, y: 6, z: 0.5 }, color: 0x787878 },
    { id: 'b1_wall_s_l', type: 'box', position: { x: -5.5, y: 0, z: 15 }, size: { x: 9, y: 6, z: 0.5 }, color: 0x787878 }, // Linker Teil der Südwand
    { id: 'b1_wall_s_r', type: 'box', position: { x: 5.5, y: 0, z: 15 }, size: { x: 9, y: 6, z: 0.5 }, color: 0x787878 }, // Rechter Teil
    // Über der Tür
    { id: 'b1_wall_s_top', type: 'box', position: { x: 0, y: 3, z: 15 }, size: { x: 2, y: 3, z: 0.5 }, color: 0x787878 }, 

    { id: 'b1_wall_e', type: 'box', position: { x: 10, y: 0, z: 0 }, size: { x: 0.5, y: 6, z: 30.5 }, color: 0x787878 },
    { id: 'b1_wall_w', type: 'box', position: { x: -10, y: 0, z: 0 }, size: { x: 0.5, y: 6, z: 30.5 }, color: 0x787878 },
    { id: 'b1_roof', type: 'box', position: { x: 0, y: 6, z: 0 }, size: { x: 20.5, y: 0.5, z: 30.5 }, color: 0x676767 },
    // Öffnungen werden nicht als Kollisionsobjekte geführt, sondern sind Lücken zwischen Objekten.

    // Deckungsobjekte
    { id: 'cover1', type: 'box', position: { x: 20, y: 0, z: 10 }, size: { x: 1, y: 1.5, z: 4 }, color: 0x909090 },
    { id: 'cover2', type: 'box', position: { x: -20, y: 0, z: -12 }, size: { x: 5, y: 1, z: 1.5 }, color: 0x909090 },
    { id: 'platform_center', type: 'box', position: { x: 0, y: 3, z: 0 }, size: { x: 6, y: 0.5, z: 6 }, color: 0xa0a0a0, insideBuilding: true }, // Markierung für Sounds
    { id: 'ramp_to_platform', type: 'ramp', position: {x: -6, y:0, z: 0}, size: {x:6, y:3, z:2}, color: 0xa05050, riseAxis: 'y', slopeDir: {x:1, y:0, z:0} }
];


function rayIntersectsAABB(rayOrigin, rayDirection, aabbMin, aabbMax) {
    let tmin = -Infinity, tmax = Infinity;
    for (let i = 0; i < 3; i++) {
        const invD = 1.0 / rayDirection[i];
        let t0 = (aabbMin[i] - rayOrigin[i]) * invD;
        let t1 = (aabbMax[i] - rayOrigin[i]) * invD;
        if (invD < 0.0) { let temp = t0; t0 = t1; t1 = temp; }
        tmin = Math.max(tmin, t0);
        tmax = Math.min(tmax, t1);
        if (tmin > tmax) return null;
    }
    if (tmin < 0 && tmax < 0) return null;
    return tmin >= 0 ? tmin : (tmax >= 0 ? tmax : null);
}

function getPlayerAABB(playerPos, playerHeight, playerWidth) {
    return {
        minX: playerPos.x - playerWidth / 2, maxX: playerPos.x + playerWidth / 2,
        minY: playerPos.y, maxY: playerPos.y + playerHeight,
        minZ: playerPos.z - playerWidth / 2, maxZ: playerPos.z + playerWidth / 2,
    };
}

function rayIntersectsPlayer(rayOrigin, rayDirection, targetPlayer, maxDistance = Infinity) {
    const pAABB = getPlayerAABB(targetPlayer.position, 
        (targetPlayer.isCrouching ? playerDimensions.crouchHeight : playerDimensions.height), 
        playerDimensions.width);
    const targetAABBMin = [pAABB.minX, pAABB.minY, pAABB.minZ];
    const targetAABBMax = [pAABB.maxX, pAABB.maxY, pAABB.maxZ];
    const rayOriginArray = [rayOrigin.x, rayOrigin.y, rayOrigin.z];
    const rayDirectionArray = [rayDirection.x, rayDirection.y, rayDirection.z];
    const dist = rayIntersectsAABB(rayOriginArray, rayDirectionArray, targetAABBMin, targetAABBMax);
    if (dist !== null && dist < maxDistance) return dist;
    return null;
}

wss.on('connection', (ws) => {
    const playerId = uuidv4();
    console.log(`Client ${playerId} verbunden.`);
    players[playerId] = {
        id: playerId, ws: ws, username: "Guest" + Math.floor(Math.random() * 1000),
        position: { x: Math.random() * 20 - 10, y: gameSettings.respawnHeight, z: Math.random() * 20 - 10 },
        velocity: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0 }, health: gameSettings.maxHealth,
        isCrouching: false, isSprinting: false, isSliding: false, isOnGround: false,
        lastWallContact: null, lastShotTime: 0, slideEndTime: 0, inputs: {},
        currentWeapon: DEFAULT_WEAPON, lastStepTime: 0,
    };
    ws.send(JSON.stringify({
        type: 'welcome', id: playerId, settings: gameSettings, players: players,
        worldObjects: worldObjects, weaponData: WEAPON_DATA
    }));
    broadcast({ type: 'playerJoined', player: stripPlayerData(players[playerId]) });

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            const player = players[playerId];
            if (!player) return;
            switch (data.type) {
                case 'login': player.username = data.username || player.username; broadcast({ type: 'playerUpdated', player: stripPlayerData(player) }); break;
                case 'playerUpdate': if (data.inputs) player.inputs = data.inputs; if (data.rotation) player.rotation = data.rotation; break;
                case 'selectWeapon':
                    if (WEAPON_DATA[data.weaponId]) {
                        player.currentWeapon = data.weaponId;
                        console.log(`Spieler ${player.username} wählte ${player.currentWeapon}`);
                        broadcast({type: 'playerWeaponChanged', playerId: playerId, weaponId: player.currentWeapon});
                    } break;
                case 'shoot':
                    const weapon = WEAPON_DATA[player.currentWeapon];
                    if (!weapon) return;
                    if (Date.now() - player.lastShotTime > weapon.fireRate) {
                        player.lastShotTime = Date.now();
                        const shooter = player;
                        const shooterHeight = shooter.isCrouching ? playerDimensions.crouchHeight : playerDimensions.height;
                        const shootOrigin = { x: shooter.position.x, y: shooter.position.y + shooterHeight * playerDimensions.eyeHeightFactor, z: shooter.position.z };
                        
                        let closestHitDist = gameSettings.maxRayDistance;
                        let hitTargetType = null, hitPlayerId = null;
                        const rayDirArr = [data.direction.x, data.direction.y, data.direction.z];
                        const shootOriginArr = [shootOrigin.x, shootOrigin.y, shootOrigin.z];

                        for (const obj of worldObjects) {
                            const objMin = [obj.position.x - obj.size.x / 2, obj.position.y, obj.position.z - obj.size.z / 2];
                            const objMax = [obj.position.x + obj.size.x / 2, obj.position.y + obj.size.y, obj.position.z + obj.size.z / 2];
                            const worldHit = rayIntersectsAABB(shootOriginArr, rayDirArr, objMin, objMax);
                            if (worldHit !== null && worldHit < closestHitDist) {
                                closestHitDist = worldHit; hitTargetType = 'world'; hitPlayerId = null;
                            }
                        }
                        for (const otherId in players) {
                            if (otherId === playerId || players[otherId].health <= 0) continue;
                            const playerHit = rayIntersectsPlayer(shootOrigin, data.direction, players[otherId], closestHitDist);
                            if (playerHit !== null) {
                                closestHitDist = playerHit; hitTargetType = 'player'; hitPlayerId = otherId;
                            }
                        }
                        broadcast({ type: 'playerShot', playerId: playerId, weaponId: player.currentWeapon, startPos: shootOrigin, direction: data.direction, hitTarget: hitTargetType, hitDistance: closestHitDist });
                        if (hitTargetType === 'player' && hitPlayerId) {
                            const target = players[hitPlayerId];
                            target.health = Math.max(0, target.health - weapon.damage);
                            broadcast({ type: 'hit', shooterId: playerId, targetId: hitPlayerId, damage: weapon.damage, newHealth: target.health });
                            if (target.health <= 0) respawnPlayer(target);
                        }
                    } break;
            }
        } catch (e) { console.error('Msg Error:', e, message.toString()); }
    });
    ws.on('close', () => { console.log(`Client ${playerId} getrennt.`); delete players[playerId]; broadcast({ type: 'playerLeft', id: playerId }); });
});

function stripPlayerData(player) {
    return {
        id: player.id, username: player.username, position: player.position, velocity: player.velocity,
        rotation: player.rotation, health: player.health, isCrouching: player.isCrouching,
        isSliding: player.isSliding, isOnGround: player.isOnGround, currentWeapon: player.currentWeapon,
    };
}
function broadcast(data) { const msg = JSON.stringify(data); wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });}
function respawnPlayer(player) {
    player.health = gameSettings.maxHealth;
    player.position = { x: (Math.random() * 2 - 1) * (gameSettings.worldBounds.x*0.8), y: gameSettings.respawnHeight, z: (Math.random() * 2 - 1) * (gameSettings.worldBounds.z*0.8) };
    player.velocity = { x: 0, y: 0, z: 0 }; player.isSliding = false;
    broadcast({ type: 'playerRespawn', player: stripPlayerData(player) });
}

// Die `checkWorldCollision` Funktion von unserer letzten funktionierenden Version:
function checkWorldCollision(player, currentPos, desiredMovementDelta) {
    let resolvedPosition = { ...currentPos }; 
    let nextPositionAttempt = {
        x: currentPos.x + desiredMovementDelta.x,
        y: currentPos.y + desiredMovementDelta.y,
        z: currentPos.z + desiredMovementDelta.z,
    };

    let collisionInfo = { occurred: false, normal: { x: 0, y: 0, z: 0 }, isGroundCollision: false };
    const playerCurrentHeight = player.isCrouching ? playerDimensions.crouchHeight : playerDimensions.height;

    // Bodenkollision y=0
    if (nextPositionAttempt.y < 0) { 
        resolvedPosition.y = 0;
        player.velocity.y = 0;
        collisionInfo.isGroundCollision = true; // Mark as ground collision
        collisionInfo.occurred = true;
        collisionInfo.normal = { x: 0, y: 1, z: 0 };
    } else {
        resolvedPosition.y = nextPositionAttempt.y; 
    }

    // Temporäre Positionen für Achsen-Tests
    let tempPosX = resolvedPosition.x + desiredMovementDelta.x; // Start from current y-resolved, desired x
    let tempPosZ = resolvedPosition.z + desiredMovementDelta.z; // Start from current y-resolved, desired z
    
    let colNormal = {x:0, y:0, z:0}; // Wird von der ersten signifikanten Kollision gesetzt

    for (const obj of worldObjects) {
        const objAABB = {
            minX: obj.position.x - obj.size.x / 2, maxX: obj.position.x + obj.size.x / 2,
            minY: obj.position.y, maxY: obj.position.y + obj.size.y,
            minZ: obj.position.z - obj.size.z / 2, maxZ: obj.position.z + obj.size.z / 2,
        };

        // Teste X-Achse
        const playerAABB_X = getPlayerAABB({x: tempPosX, y: resolvedPosition.y, z: resolvedPosition.z}, playerCurrentHeight, playerDimensions.width);
        if (playerAABB_X.maxX > objAABB.minX && playerAABB_X.minX < objAABB.maxX &&
            playerAABB_X.maxY > objAABB.minY && playerAABB_X.minY < objAABB.maxY &&
            playerAABB_X.maxZ > objAABB.minZ && playerAABB_X.minZ < objAABB.maxZ) {
            
            const overlapX = (playerDimensions.width / 2 + obj.size.x / 2) - Math.abs(tempPosX - obj.position.x);
            if (overlapX > 0) {
                const pushSign = Math.sign(tempPosX - obj.position.x);
                tempPosX = obj.position.x + pushSign * (obj.size.x / 2 + playerDimensions.width / 2 + 0.001);
                player.velocity.x = 0; 
                colNormal = { x: pushSign, y: 0, z: 0 };
                collisionInfo.occurred = true;
            }
        }
        resolvedPosition.x = tempPosX; // Akzeptiere die (möglicherweise korrigierte) X-Position

        // Teste Z-Achse (mit der jetzt korrigierten X-Position)
        const playerAABB_Z = getPlayerAABB({x: resolvedPosition.x, y: resolvedPosition.y, z: tempPosZ}, playerCurrentHeight, playerDimensions.width);
         if (playerAABB_Z.maxX > objAABB.minX && playerAABB_Z.minX < objAABB.maxX &&
            playerAABB_Z.maxY > objAABB.minY && playerAABB_Z.minY < objAABB.maxY &&
            playerAABB_Z.maxZ > objAABB.minZ && playerAABB_Z.minZ < objAABB.maxZ) {
            
            const overlapZ = (playerDimensions.width / 2 + obj.size.z / 2) - Math.abs(tempPosZ - obj.position.z);
            if (overlapZ > 0) {
                const pushSign = Math.sign(tempPosZ - obj.position.z);
                tempPosZ = obj.position.z + pushSign * (obj.size.z / 2 + playerDimensions.width / 2 + 0.001);
                player.velocity.z = 0;
                // Nur Z-Normale setzen, wenn keine X-Kollision priorisiert wurde oder wenn diese stärker ist
                if (!collisionInfo.occurred || Math.abs(colNormal.x) < 0.1) {
                     colNormal = { x: 0, y: 0, z: pushSign };
                }
                collisionInfo.occurred = true;
            }
        }
        resolvedPosition.z = tempPosZ;

        // Teste Y-Achse (mit den jetzt korrigierten X und Z Positionen)
        // Dies ist wichtig, um auf Objekten zu landen oder unter Decken zu stoppen
        const playerAABB_Y = getPlayerAABB(resolvedPosition, playerCurrentHeight, playerDimensions.width);
        if (playerAABB_Y.maxX > objAABB.minX && playerAABB_Y.minX < objAABB.maxX &&
            playerAABB_Y.maxY > objAABB.minY && playerAABB_Y.minY < objAABB.maxY &&
            playerAABB_Y.maxZ > objAABB.minZ && playerAABB_Y.minZ < objAABB.maxZ) {

            const overlapY = (playerCurrentHeight / 2 + obj.size.y / 2) - Math.abs((resolvedPosition.y + playerCurrentHeight/2) - (obj.position.y + obj.size.y/2));
            if(overlapY > 0){
                const pushSignY = Math.sign((resolvedPosition.y + playerCurrentHeight/2) - (obj.position.y + obj.size.y/2));
                resolvedPosition.y = (obj.position.y + obj.size.y/2) + pushSignY * (obj.size.y/2 + playerCurrentHeight/2 + 0.001) - playerCurrentHeight/2;
                player.velocity.y = 0;

                if (pushSignY > 0 && overlapY > 0.01) { // Von unten gegen Objekt oder darauf gelandet
                    collisionInfo.isGroundCollision = true;
                    colNormal = { x: 0, y: 1, z: 0 }; // Dominante Bodennormale
                } else {
                    colNormal = { x: 0, y: -1, z: 0 }; // Decke
                }
                collisionInfo.occurred = true;
            }
        }
        if(collisionInfo.occurred && obj.type !== 'ramp') break; // Nur eine Kollision pro Frame mit normalen Boxen
                                                    // Rampen könnten mehrere Iterationen benötigen oder eine andere Logik
    }
    
    // Wenn eine Kollision aufgetreten ist, setze die Normale für Walljump etc.
    if (collisionInfo.occurred) {
        player.lastWallContact = (Math.abs(colNormal.y) < 0.7 && (Math.abs(colNormal.x) > 0.1 || Math.abs(colNormal.z) > 0.1)) ? 
                                 { normal: colNormal, time: Date.now() } : null;
    } else {
        player.lastWallContact = null;
    }
    
    player.isOnGround = collisionInfo.isGroundCollision;

    // World Bounds am Ende
    if (Math.abs(resolvedPosition.x) > gameSettings.worldBounds.x) {
        resolvedPosition.x = Math.sign(resolvedPosition.x) * gameSettings.worldBounds.x; player.velocity.x = 0;
    }
    if (Math.abs(resolvedPosition.z) > gameSettings.worldBounds.z) {
        resolvedPosition.z = Math.sign(resolvedPosition.z) * gameSettings.worldBounds.z; player.velocity.z = 0;
    }
    if (resolvedPosition.y < gameSettings.worldBounds.y_min) { respawnPlayer(player); return currentPos; }

    return resolvedPosition;
}

function gameLoop() {
    const deltaTime = 1 / 60;
    for (const playerId in players) {
        const player = players[playerId];
        if (!player.inputs || Object.keys(player.inputs).length === 0) continue; 
        const inputs = player.inputs; 
        const oldPos = { ...player.position };
        player.isSprinting = inputs.sprint && !player.isCrouching && !player.isSliding;
        
        let currentSpeed = gameSettings.playerSpeed;
        if (player.isSprinting) currentSpeed = gameSettings.playerSprintSpeed;
        if (player.isCrouching && !player.isSliding) currentSpeed = gameSettings.playerCrouchSpeed;
        
        let moveDirection = { x: 0, z: 0 };
        if (inputs.forward) { moveDirection.x -= Math.sin(player.rotation.y); moveDirection.z -= Math.cos(player.rotation.y); }
        if (inputs.backward) { moveDirection.x += Math.sin(player.rotation.y); moveDirection.z += Math.cos(player.rotation.y); }
        if (inputs.left) { moveDirection.x += Math.sin(player.rotation.y - Math.PI / 2); moveDirection.z += Math.cos(player.rotation.y - Math.PI / 2); }
        if (inputs.right) { moveDirection.x += Math.sin(player.rotation.y + Math.PI / 2); moveDirection.z += Math.cos(player.rotation.y + Math.PI / 2); }
        const moveDirectionLength = Math.sqrt(moveDirection.x**2 + moveDirection.z**2);
        if (moveDirectionLength > 0) { moveDirection.x /= moveDirectionLength; moveDirection.z /= moveDirectionLength; }
        
        if (player.isOnGround) {
            const targetVelX = moveDirection.x * currentSpeed;
            const targetVelZ = moveDirection.z * currentSpeed;
            const groundAccelFactor = player.isSliding ? 0.04 : 0.25;
            player.velocity.x += (targetVelX - player.velocity.x) * groundAccelFactor;
            player.velocity.z += (targetVelZ - player.velocity.z) * groundAccelFactor;
        } else {
            const airWishSpeed = gameSettings.playerSpeed * 1.1; // Etwas mehr Kontrolle in der Luft
            const airAccelerationValue = 35; 
            if (moveDirectionLength > 0.01) {
                const currentSpeedInWishDir = player.velocity.x * moveDirection.x + player.velocity.z * moveDirection.z;
                let addSpeed = airWishSpeed - currentSpeedInWishDir;
                if (addSpeed > 0) {
                    let accel = airAccelerationValue * deltaTime;
                    if (accel > addSpeed) accel = addSpeed;
                    player.velocity.x += moveDirection.x * accel;
                    player.velocity.z += moveDirection.z * accel;
                }
            }
        }

        const wantsToCrouch = inputs.crouch;
        if (wantsToCrouch && player.isSprinting && player.isOnGround && !player.isSliding && Math.sqrt(player.velocity.x**2 + player.velocity.z**2) > gameSettings.playerSpeed * 0.6 ) {
            player.isSliding = true; player.isCrouching = true;
            player.slideEndTime = Date.now() + gameSettings.slideDuration;
            let slideBoostDir = {x: player.velocity.x, z: player.velocity.z};
            const currentSpeedMagForBoost = Math.sqrt(slideBoostDir.x**2 + slideBoostDir.z**2);
            if (currentSpeedMagForBoost > 0.5) { slideBoostDir.x /= currentSpeedMagForBoost; slideBoostDir.z /= currentSpeedMagForBoost; }
            else { slideBoostDir.x = Math.sin(player.rotation.y); slideBoostDir.z = Math.cos(player.rotation.y); }
            player.velocity.x += slideBoostDir.x * gameSettings.slideBoost;
            player.velocity.z += slideBoostDir.z * gameSettings.slideBoost;
        }
        if (player.isSliding && (Date.now() > player.slideEndTime || !wantsToCrouch || (player.velocity.x**2 + player.velocity.z**2 < 2**2 && player.isOnGround))) {
            player.isSliding = false;
        }
        player.isCrouching = wantsToCrouch || player.isSliding;

        if (inputs.jump && player.isOnGround) {
            player.velocity.y = gameSettings.jumpVelocity; player.isOnGround = false;
        } else if (inputs.jump && player.lastWallContact && Date.now() - player.lastWallContact.time < gameSettings.wallStickTime) {
            player.velocity.y = gameSettings.jumpVelocity * 0.85;
            player.velocity.x = player.lastWallContact.normal.x * gameSettings.wallJumpBoost;
            player.velocity.z = player.lastWallContact.normal.z * gameSettings.wallJumpBoost;
            player.lastWallContact = null; player.isOnGround = false;
        }
        player.inputs.jump = false;

        if (!player.isOnGround) player.velocity.y += gameSettings.gravity * deltaTime;
        else if (player.velocity.y < 0) player.velocity.y = 0;

        const desiredMovementDelta = { x: player.velocity.x * deltaTime, y: player.velocity.y * deltaTime, z: player.velocity.z * deltaTime };
        const newPosition = checkWorldCollision(player, player.position, desiredMovementDelta);
        player.position = newPosition;

        const distMovedSqr = (player.position.x - oldPos.x)**2 + (player.position.z - oldPos.z)**2;
        if (player.isOnGround && !player.isSliding && distMovedSqr > (0.05*0.05) && (Math.abs(player.velocity.x) > 0.5 || Math.abs(player.velocity.z) > 0.5) ) {
            const stepInterval = player.isSprinting ? gameSettings.stepSoundInterval / 1.4 : (player.isCrouching ? gameSettings.stepSoundInterval * 1.5 : gameSettings.stepSoundInterval);
            if (Date.now() - player.lastStepTime > stepInterval) {
                player.lastStepTime = Date.now();
                broadcast({ type: 'playerStep', playerId: playerId, position: player.position });
            }
        }
        
        const noHorizontalInput = moveDirectionLength < 0.1;
        if (player.isOnGround) {
            if (!player.isSliding && noHorizontalInput) { player.velocity.x *= 0.70; player.velocity.z *= 0.70; }
            else if (player.isSliding) { player.velocity.x *= 0.975; player.velocity.z *= 0.975; }
        } else { const airDamping = 0.993; player.velocity.x *= airDamping; player.velocity.z *= airDamping; }
        if (player.isOnGround && noHorizontalInput && Math.abs(player.velocity.x) < 0.05) player.velocity.x = 0;
        if (player.isOnGround && noHorizontalInput && Math.abs(player.velocity.z) < 0.05) player.velocity.z = 0;
        if(player.isOnGround) player.lastWallContact = null;
    }
    const allPlayersData = {}; for (const id in players) allPlayersData[id] = stripPlayerData(players[id]);
    broadcast({ type: 'gameStateUpdate', players: allPlayersData });
}
setInterval(gameLoop, 1000 / 60);