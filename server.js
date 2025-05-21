import { WebSocketServer, WebSocket } from 'ws'; // WebSocket hier importieren
import { v4 as uuidv4 } from 'uuid';

const wss = new WebSocketServer({ port: 8080 });
console.log('WebSocket Server gestartet auf Port 8080');

const players = {};
const projectiles = {}; // Nicht mehr wirklich genutzt für Hitscan, aber Struktur bleibt
const gameSettings = {
    gravity: -30,
    playerSpeed: 10,
    playerSprintSpeed: 15,
    playerCrouchSpeed: 5,
    jumpVelocity: 12,
    slideBoost: 18, // Etwas reduziert für besseres Gefühl
    slideDuration: 600, // ms
    wallJumpBoost: 15,
    wallStickTime: 250, // ms, etwas länger für einfachere Ausführung
    maxHealth: 100,
    damagePerHit: 5, // 100 / 5 = 20 hits
    worldBounds: { x: 50, z: 50, y_min: -20 },
    respawnHeight: 5,
    maxRayDistance: 100, // Maximale Schussweite
};

const playerDimensions = {
    height: 1.8,
    crouchHeight: 1.0,
    width: 0.5,
    eyeHeightFactor: 0.9, // Faktor für Augenhöhe relativ zur Gesamthöhe
};

// Dummy world for collision
const worldObjects = [
    { id: 'wall1', type: 'box', position: { x: 10, y: 0, z: 0 }, size: { x: 2, y: 4, z: 10 }, color: 0xaaaaaa },
    { id: 'obstacle1', type: 'box', position: { x: 0, y: 0, z: 10 }, size: { x: 10, y: 2, z: 2 }, color: 0xbbbbbb },
    { id: 'platform1', type: 'box', position: { x: -10, y: 3, z: -5 }, size: { x: 5, y: 0.5, z: 5 }, color: 0xcccccc },
];


// --- Hilfsfunktionen für Kollision und Raycasting ---
function rayIntersectsAABB(rayOrigin, rayDirection, aabbMin, aabbMax) {
    let tmin = -Infinity, tmax = Infinity;

    for (let i = 0; i < 3; i++) { // Iterate over x, y, z
        const invD = 1.0 / rayDirection[i]; // Sicherstellen, dass es float ist
        let t0 = (aabbMin[i] - rayOrigin[i]) * invD;
        let t1 = (aabbMax[i] - rayOrigin[i]) * invD;

        if (invD < 0.0) {
            let temp = t0;
            t0 = t1;
            t1 = temp;
        }

        tmin = Math.max(tmin, t0);
        tmax = Math.min(tmax, t1);

        if (tmin > tmax) return null; // No intersection
    }
    if (tmin < 0 && tmax < 0) return null; // Object is behind the ray
    return tmin >= 0 ? tmin : (tmax >= 0 ? tmax : null);
}

function getPlayerAABB(player) {
    const currentHeight = player.isCrouching ? playerDimensions.crouchHeight : playerDimensions.height;
    return {
        minX: player.position.x - playerDimensions.width / 2, maxX: player.position.x + playerDimensions.width / 2,
        minY: player.position.y, maxY: player.position.y + currentHeight,
        minZ: player.position.z - playerDimensions.width / 2, maxZ: player.position.z + playerDimensions.width / 2,
    };
}

function rayIntersectsPlayer(rayOrigin, rayDirection, targetPlayer, maxDistance = Infinity) {
    const targetAABB = getPlayerAABB(targetPlayer);
    const targetAABBMin = [targetAABB.minX, targetAABB.minY, targetAABB.minZ];
    const targetAABBMax = [targetAABB.maxX, targetAABB.maxY, targetAABB.maxZ];

    const rayOriginArray = [rayOrigin.x, rayOrigin.y, rayOrigin.z];
    const rayDirectionArray = [rayDirection.x, rayDirection.y, rayDirection.z];

    const dist = rayIntersectsAABB(rayOriginArray, rayDirectionArray, targetAABBMin, targetAABBMax);

    if (dist !== null && dist < maxDistance) {
        return dist;
    }
    return null;
}


wss.on('connection', (ws) => {
    const playerId = uuidv4();
    console.log(`Client ${playerId} verbunden.`);

    players[playerId] = {
        id: playerId,
        ws: ws,
        username: "Guest" + Math.floor(Math.random() * 1000),
        position: { x: Math.random() * 10 - 5, y: gameSettings.respawnHeight, z: Math.random() * 10 - 5 },
        velocity: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0 },
        health: gameSettings.maxHealth,
        isCrouching: false,
        isSprinting: false,
        isSliding: false,
        isOnGround: false,
        lastWallContact: null,
        lastShotTime: 0,
        slideEndTime: 0,
        inputs: { /* wird vom Client initialisiert */ }
    };

    // Sende Weltobjekte einmalig beim Welcome
    ws.send(JSON.stringify({
        type: 'welcome',
        id: playerId,
        settings: gameSettings,
        players: players, // Alle aktuellen Spieler
        worldObjects: worldObjects // Sende auch die Weltobjekte
    }));

    broadcast({ type: 'playerJoined', player: stripPlayerData(players[playerId]) });

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            const player = players[playerId];
            if (!player) return;

            switch (data.type) {
                case 'login':
                    player.username = data.username || player.username;
                    broadcast({ type: 'playerUpdated', player: stripPlayerData(player) });
                    break;
                case 'playerUpdate':
                    if (data.inputs) player.inputs = data.inputs;
                    if (data.rotation) player.rotation = data.rotation;
                    break;
                case 'shoot':
                    if (Date.now() - player.lastShotTime > 200) { // Fire rate limit
                        player.lastShotTime = Date.now();
                        const shooterPlayer = player;
                        const currentShooterHeight = shooterPlayer.isCrouching ? playerDimensions.crouchHeight : playerDimensions.height;
                        const shootOrigin = {
                            x: shooterPlayer.position.x,
                            y: shooterPlayer.position.y + currentShooterHeight * playerDimensions.eyeHeightFactor,
                            z: shooterPlayer.position.z
                        };

                        let closestHitDistance = gameSettings.maxRayDistance;
                        let hitTarget = null; // Kann Spieler-ID oder 'world' sein
                        let hitPlayerId = null;

                        // 1. Check for world object hits
                        const rayDirArray = [data.direction.x, data.direction.y, data.direction.z];
                        const shootOriginArray = [shootOrigin.x, shootOrigin.y, shootOrigin.z];

                        for (const obj of worldObjects) {
                            const objAABBMin = [obj.position.x - obj.size.x / 2, obj.position.y, obj.position.z - obj.size.z / 2];
                            const objAABBMax = [obj.position.x + obj.size.x / 2, obj.position.y + obj.size.y, obj.position.z + obj.size.z / 2];
                            
                            const worldHitDist = rayIntersectsAABB(shootOriginArray, rayDirArray, objAABBMin, objAABBMax);

                            if (worldHitDist !== null && worldHitDist < closestHitDistance) {
                                closestHitDistance = worldHitDist;
                                hitTarget = 'world';
                                hitPlayerId = null; // Wichtig zurücksetzen
                            }
                        }

                        // 2. Check for player hits (nur wenn näher als Welthit oder kein Welthit)
                        for (const otherId in players) {
                            if (otherId === playerId) continue;
                            const targetPlayer = players[otherId];
                            if (targetPlayer.health <= 0) continue; // Nicht auf tote Spieler schießen

                            const playerHitDist = rayIntersectsPlayer(shootOrigin, data.direction, targetPlayer, closestHitDistance);

                            if (playerHitDist !== null) { // playerHitDist ist jetzt die Distanz oder null
                                closestHitDistance = playerHitDist;
                                hitTarget = 'player';
                                hitPlayerId = otherId;
                            }
                        }
                        
                        // Client-seitiges Projektil (visuell)
                        broadcast({ type: 'projectileFired', 
                            playerId: playerId, 
                            startPos: shootOrigin, // Start von Augenhöhe
                            direction: data.direction, 
                            hitTarget: hitTarget, // Sagen, was getroffen wurde
                            hitDistance: closestHitDistance // Sagen, wo es getroffen hat
                        });


                        // 3. Process hit
                        if (hitTarget === 'player' && hitPlayerId) {
                            const pTarget = players[hitPlayerId];
                            pTarget.health -= gameSettings.damagePerHit;
                            broadcast({ type: 'hit', shooterId: playerId, targetId: hitPlayerId, damage: gameSettings.damagePerHit, newHealth: pTarget.health });
                            console.log(`${shooterPlayer.username} hit ${pTarget.username} (${hitPlayerId}) for ${gameSettings.damagePerHit}. New health: ${pTarget.health}. Dist: ${closestHitDistance.toFixed(2)}`);
                            if (pTarget.health <= 0) {
                                respawnPlayer(pTarget);
                            }
                        } else if (hitTarget === 'world') {
                            console.log(`${shooterPlayer.username}'s shot hit a wall at dist ${closestHitDistance.toFixed(2)}.`);
                            // Optional: broadcast({ type: 'worldHit', position: { x: shootOrigin.x + data.direction.x * closestHitDistance, ... } });
                        }
                    }
                    break;
            }
        } catch (e) {
            console.error('Fehler beim Verarbeiten der Nachricht:', e, message.toString());
        }
    });

    ws.on('close', () => {
        console.log(`Client ${playerId} getrennt.`);
        delete players[playerId];
        broadcast({ type: 'playerLeft', id: playerId });
    });
});

function stripPlayerData(player) {
    return {
        id: player.id,
        username: player.username,
        position: player.position,
        velocity: player.velocity, // Sende auch Velocity für Debug im Client
        rotation: player.rotation,
        health: player.health,
        isCrouching: player.isCrouching,
        isSliding: player.isSliding,
        isOnGround: player.isOnGround, // Sende auch isOnGround für Debug
    };
}

function broadcast(data) {
    const message = JSON.stringify(data);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) { // WebSocket ist hier definiert (Import)
            client.send(message);
        }
    });
}

function respawnPlayer(player) {
    player.health = gameSettings.maxHealth;
    player.position = { x: Math.random() * 20 - 10, y: gameSettings.respawnHeight, z: Math.random() * 20 - 10 };
    player.velocity = { x: 0, y: 0, z: 0 };
    player.isSliding = false;
    broadcast({ type: 'playerRespawn', player: stripPlayerData(player) });
    console.log(`${player.username} respawned.`);
}


function checkWorldCollision(player, nextPosition) {
    let collision = null;
    const playerCurrentHeight = player.isCrouching ? playerDimensions.crouchHeight : playerDimensions.height;
    const playerAABB = {
        minX: nextPosition.x - playerDimensions.width / 2, maxX: nextPosition.x + playerDimensions.width / 2,
        minY: nextPosition.y, maxY: nextPosition.y + playerCurrentHeight,
        minZ: nextPosition.z - playerDimensions.width / 2, maxZ: nextPosition.z + playerDimensions.width / 2,
    };

    let onGroundCandidate = false;

    // Ground collision
    if (nextPosition.y < 0) {
        nextPosition.y = 0;
        player.velocity.y = 0;
        onGroundCandidate = true;
        collision = { normal: { x: 0, y: 1, z: 0 } };
    }

    // World bounds
    if (Math.abs(nextPosition.x) > gameSettings.worldBounds.x) {
        nextPosition.x = Math.sign(nextPosition.x) * gameSettings.worldBounds.x;
        player.velocity.x = 0;
        collision = collision || { normal: { x: -Math.sign(nextPosition.x), y: 0, z: 0 } };
    }
    if (Math.abs(nextPosition.z) > gameSettings.worldBounds.z) {
        nextPosition.z = Math.sign(nextPosition.z) * gameSettings.worldBounds.z;
        player.velocity.z = 0;
        collision = collision || { normal: { x: 0, y: 0, z: -Math.sign(nextPosition.z) } };
    }
    if (nextPosition.y < gameSettings.worldBounds.y_min) {
        respawnPlayer(player);
        return null; // Abbrechen, da respawnt
    }
    

    for (const obj of worldObjects) {
        const objAABB = {
            minX: obj.position.x - obj.size.x / 2, maxX: obj.position.x + obj.size.x / 2,
            minY: obj.position.y, maxY: obj.position.y + obj.size.y,
            minZ: obj.position.z - obj.size.z / 2, maxZ: obj.position.z + obj.size.z / 2,
        };

        if (playerAABB.maxX > objAABB.minX && playerAABB.minX < objAABB.maxX &&
            playerAABB.maxY > objAABB.minY && playerAABB.minY < objAABB.maxY &&
            playerAABB.maxZ > objAABB.minZ && playerAABB.minZ < objAABB.maxZ) {
            
            const dx = (playerAABB.minX + playerAABB.maxX) / 2 - (objAABB.minX + objAABB.maxX) / 2;
            const dy = (playerAABB.minY + playerAABB.maxY) / 2 - (objAABB.minY + objAABB.maxY) / 2;
            const dz = (playerAABB.minZ + playerAABB.maxZ) / 2 - (objAABB.minZ + objAABB.maxZ) / 2;
            
            const widths = (playerAABB.maxX - playerAABB.minX) / 2 + (objAABB.maxX - objAABB.minX) / 2;
            const heights = (playerAABB.maxY - playerAABB.minY) / 2 + (objAABB.maxY - objAABB.minY) / 2;
            const depths = (playerAABB.maxZ - playerAABB.minZ) / 2 + (objAABB.maxZ - objAABB.minZ) / 2;

            const overlapX = widths - Math.abs(dx);
            const overlapY = heights - Math.abs(dy);
            const overlapZ = depths - Math.abs(dz);

            let normal = {x:0, y:0, z:0};

            if (overlapY < overlapX && overlapY < overlapZ) {
                nextPosition.y -= Math.sign(dy) * overlapY;
                player.velocity.y = 0;
                if (Math.sign(dy) < 0) { // Landed on top
                    onGroundCandidate = true;
                    normal = {x:0, y:1, z:0};
                } else { normal = {x:0, y:-1, z:0}; } // Hit head
            } else if (overlapX < overlapZ) {
                nextPosition.x -= Math.sign(dx) * overlapX;
                player.velocity.x = 0;
                normal = {x:-Math.sign(dx), y:0, z:0};
            } else {
                nextPosition.z -= Math.sign(dz) * overlapZ;
                player.velocity.z = 0;
                normal = {x:0, y:0, z:-Math.sign(dz)};
            }
            collision = collision || { normal }; // Behalte vorherige Kollision, wenn dies die erste ist
        }
    }
    player.isOnGround = onGroundCandidate; // Setze isOnGround basierend auf den Kollisionen dieses Frames
    return collision;
}


function gameLoop() {
    const deltaTime = 1 / 60;

    for (const playerId in players) {
        const player = players[playerId];
        if (!player.inputs) continue; // Spieler noch nicht vollständig initialisiert
        const inputs = player.inputs;

        player.isSprinting = inputs.sprint && !player.isCrouching && !player.isSliding; // Update isSprinting state

        let currentSpeed = gameSettings.playerSpeed;
        if (player.isSprinting) currentSpeed = gameSettings.playerSprintSpeed;
        if (player.isCrouching && !player.isSliding) currentSpeed = gameSettings.playerCrouchSpeed;
        
        let moveDirection = { x: 0, z: 0 };
        if (inputs.forward) {
            moveDirection.x -= Math.sin(player.rotation.y);
            moveDirection.z -= Math.cos(player.rotation.y);
        }
        // ... (backward, left, right as before) ...
        if (inputs.backward) {
            moveDirection.x += Math.sin(player.rotation.y);
            moveDirection.z += Math.cos(player.rotation.y);
        }
        if (inputs.left) {
            moveDirection.x += Math.sin(player.rotation.y - Math.PI / 2);
            moveDirection.z += Math.cos(player.rotation.y - Math.PI / 2);
        }
        if (inputs.right) {
            moveDirection.x += Math.sin(player.rotation.y + Math.PI / 2);
            moveDirection.z += Math.cos(player.rotation.y + Math.PI / 2);
        }

        const len = Math.sqrt(moveDirection.x * moveDirection.x + moveDirection.z * moveDirection.z);
        if (len > 0) {
            moveDirection.x /= len;
            moveDirection.z /= len;
        }
        
        const targetVelX = moveDirection.x * currentSpeed;
        const targetVelZ = moveDirection.z * currentSpeed;

        // Interpoliere zur Zielgeschwindigkeit für smoothe Beschleunigung/Verzögerung
        // und Air Control
        const accelFactor = player.isOnGround ? (player.isSliding ? 0.02 : 0.1) : 0.03; // slide hat weniger kontrolle
        player.velocity.x += (targetVelX - player.velocity.x) * accelFactor;
        player.velocity.z += (targetVelZ - player.velocity.z) * accelFactor;


        // --- Crouching ---
        // isCrouching wird direkt vom Input gesetzt (oder Slide)
        const wantsToCrouch = inputs.crouch;


        // --- Sliding ---
        if (wantsToCrouch && player.isSprinting && player.isOnGround && !player.isSliding && Math.sqrt(player.velocity.x**2 + player.velocity.z**2) > gameSettings.playerSpeed * 0.8 ) {
            player.isSliding = true;
            player.isCrouching = true; // Sliden impliziert Ducken
            player.slideEndTime = Date.now() + gameSettings.slideDuration;
            
            const slideDir = {x: player.velocity.x, z: player.velocity.z};
            const currentSpeedMag = Math.sqrt(slideDir.x**2 + slideDir.z**2);
            if (currentSpeedMag > 0.1) { // Normieren
                slideDir.x /= currentSpeedMag;
                slideDir.z /= currentSpeedMag;
            } else { // Wenn keine Bewegung, dann in Blickrichtung
                 slideDir.x = Math.sin(player.rotation.y);
                 slideDir.z = Math.cos(player.rotation.y);
            }
            player.velocity.x += slideDir.x * gameSettings.slideBoost;
            player.velocity.z += slideDir.z * gameSettings.slideBoost;
            console.log(player.username, "started sliding. Vel:", player.velocity.x.toFixed(1), player.velocity.z.toFixed(1));
        }
        
        if (player.isSliding) {
            if (Date.now() > player.slideEndTime || !wantsToCrouch || player.velocity.x * player.velocity.x + player.velocity.z * player.velocity.z < 2*2) {
                player.isSliding = false;
                // player.isCrouching bleibt true, wenn die Taste gehalten wird
            }
        }
        // Update isCrouching basierend auf Input und Slide-Status
        player.isCrouching = wantsToCrouch || player.isSliding;


        // --- Jumping & Wall Jumping ---
        if (inputs.jump && player.isOnGround) {
            player.velocity.y = gameSettings.jumpVelocity;
            player.isOnGround = false; // Wichtig, um Mehrfachsprünge zu verhindern
            console.log(player.username, "jumped");
        } else if (inputs.jump && player.lastWallContact && Date.now() - player.lastWallContact.time < gameSettings.wallStickTime) {
            player.velocity.y = gameSettings.jumpVelocity * 0.9; // Guter Walljump
            player.velocity.x = player.lastWallContact.normal.x * gameSettings.wallJumpBoost;
            player.velocity.z = player.lastWallContact.normal.z * gameSettings.wallJumpBoost;
            player.lastWallContact = null;
            player.isOnGround = false;
            console.log(player.username, "wall jumped");
        }
        player.inputs.jump = false; // Jump-Input immer konsumieren


        // --- Gravity ---
        if (!player.isOnGround) {
            player.velocity.y += gameSettings.gravity * deltaTime;
        }

        // --- Friction/Damping (nur wenn am Boden und nicht sliden) ---
        if (player.isOnGround && !player.isSliding && (Math.abs(moveDirection.x) < 0.1 && Math.abs(moveDirection.z) < 0.1)) {
            player.velocity.x *= 0.85; // Stärkere Reibung bei keiner Eingabe
            player.velocity.z *= 0.85;
        } else if (player.isSliding) {
             player.velocity.x *= 0.99; // Slide Reibung
             player.velocity.z *= 0.99;
        } else if (!player.isOnGround) {
            player.velocity.x *= 0.995; // Leichte Luftreibung
            player.velocity.z *= 0.995;
        }


        if (Math.abs(player.velocity.x) < 0.01 && player.isOnGround) player.velocity.x = 0;
        if (Math.abs(player.velocity.z) < 0.01 && player.isOnGround) player.velocity.z = 0;
        
        let nextPosition = {
            x: player.position.x + player.velocity.x * deltaTime,
            y: player.position.y + player.velocity.y * deltaTime,
            z: player.position.z + player.velocity.z * deltaTime,
        };

        const collisionInfo = checkWorldCollision(player, nextPosition);
        player.position = nextPosition;

        if (collisionInfo && !player.isOnGround) {
             if (Math.abs(collisionInfo.normal.y) < 0.7) { // Nicht primär Boden/Decke
                player.lastWallContact = { normal: collisionInfo.normal, time: Date.now() };
             } else {
                player.lastWallContact = null; // Kollision mit Boden/Decke löscht Wall Contact
             }
        } else if (player.isOnGround) {
            player.lastWallContact = null;
        }
    }

    const allPlayersData = {};
    for (const id in players) {
        allPlayersData[id] = stripPlayerData(players[id]);
    }
    broadcast({ type: 'gameStateUpdate', players: allPlayersData });
}

setInterval(gameLoop, 1000 / 60);