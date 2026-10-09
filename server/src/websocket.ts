import { WebSocketServer } from "ws";
import type { Server } from "http";
import {
    createRoom,
    deleteRoom,
    generateRoomCode,
    getRoom,
} from "./rooms.js";
import { randomUUID } from "crypto";
import { WebSocket } from "ws";
import type { Message } from "@beam/shared";

const clients = new Map<string, WebSocket>(); // mapping clients to websocket
const clientRooms = new Map<string, string>(); // mapping clients to rooms

// How long a host/viewer's socket can be gone (phone locked, app backgrounded,
// brief network drop) before we treat it as a real departure. Keyed by
// clientId; presence in this map means that client is currently "grace
// period pending" - still counted as host/viewer, just without a live socket.
const GRACE_PERIOD_MS = 20000;
const graceTimers = new Map<string, NodeJS.Timeout>();

function broadcastRoomCount(roomId: string) {
    const room = getRoom(roomId);
    if (!room) {
        return;
    }

    const count = (room.host ? 1 : 0) + room.viewers.size;
    const payload = JSON.stringify({ type: "ROOM_COUNT", count });

    if (room.host) {
        room.host.socket.send(payload);
    }
    room.viewers.forEach((viewer) => {
        viewer.socket.send(payload);
    });
}

function handleLeave(clientId: string, socket: WebSocket, roomId: string) {
    const room = getRoom(roomId);
    if (!room) {
        return;
    }

    if (room.host?.clientId === clientId) {
        room.host = null;
        console.log(`host left room ${roomId}`);
        room.viewers.forEach((viewer) => {
            viewer.socket.send(JSON.stringify({ type: "HOST_LEFT" }));
        });
        room.pending.forEach((request) => {
            request.socket.send(JSON.stringify({ type: "JOIN_DENIED" }));
        });
        room.pending.clear();
    } else if (room.pending.has(clientId)) {
        room.pending.delete(clientId);
        console.log(`pending join request withdrawn in room ${roomId}`);
        if (room.host) {
            room.host.socket.send(
                JSON.stringify({ type: "JOIN_CANCELLED", clientId }),
            );
        }
    } else if (room.viewers.has(clientId)) {
        room.viewers.delete(clientId);
        console.log(`viewer left room ${roomId}`);
        const payload = JSON.stringify({ type: "VIEWER_LEFT", clientId });
        if (room.host) {
            room.host.socket.send(payload);
        }
        room.viewers.forEach((viewer) => {
            viewer.socket.send(payload);
        });
    }

    if (!room.host && room.viewers.size === 0) {
        deleteRoom(roomId);
        console.log(`room ${roomId} deleted`);
    } else {
        broadcastRoomCount(roomId);
    }
}

export function setupWebSocket(server: Server) {
    const wss = new WebSocketServer({ server });

    wss.on("connection", (socket, req) => {
        const requestedClientId = new URL(
            req.url ?? "",
            "http://localhost",
        ).searchParams.get("clientId");

        // A reconnect is only honored while the client's old clientId is
        // still sitting in a grace period (see the "close" handler below) -
        // otherwise a stale/made-up id is ignored and treated as brand new.
        const isReconnect =
            !!requestedClientId && graceTimers.has(requestedClientId);

        const clientId = isReconnect ? requestedClientId : randomUUID();

        if (isReconnect) {
            clearTimeout(graceTimers.get(clientId)!);
            graceTimers.delete(clientId);
        }

        clients.set(clientId, socket);
        console.log(
            `websocket client ${isReconnect ? "reconnected" : "connected"}: ${clientId}`,
        );
        socket.send(
            JSON.stringify({
                type: "CONNECTED",
                clientId
            }),
        );

        if (isReconnect) {
            const roomId = clientRooms.get(clientId);
            const room = roomId ? getRoom(roomId) : undefined;
            if (room) {
                const isHost = room.host?.clientId === clientId;
                if (isHost && room.host) {
                    room.host.socket = socket;
                } else if (room.viewers.has(clientId)) {
                    room.viewers.get(clientId)!.socket = socket;
                }
                const roster = room.host
                    ? [
                          { clientId: room.host.clientId, displayName: room.host.displayName },
                          ...Array.from(room.viewers.values()).map((v) => ({
                              clientId: v.clientId,
                              displayName: v.displayName,
                          })),
                      ]
                    : [];
                socket.send(
                    JSON.stringify({
                        type: "RECONNECTED",
                        roomId,
                        isHost,
                        participants: roster,
                    }),
                );

                // Anyone who tried to join while the host's socket was dead
                // had their JOIN_REQUEST silently lost (sent to a closed
                // socket) - replay those now so the host actually sees them.
                if (isHost) {
                    room.pending.forEach((request) => {
                        socket.send(
                            JSON.stringify({
                                type: "JOIN_REQUEST",
                                clientId: request.clientId,
                                displayName: request.displayName,
                            }),
                        );
                    });
                }
                console.log(`${clientId} resumed room ${roomId} after reconnecting`);
            } else {
                // Grace period hadn't expired yet, but the room is gone for
                // some other reason (e.g. everyone else also left). Nothing
                // to resume - the client just starts fresh from here.
                clientRooms.delete(clientId);
            }
        }
        socket.on("message", (data) => {
            try {
                const message: Message = JSON.parse(data.toString());

                if (message.type === "CREATE_ROOM") {
                    if (clientRooms.has(clientId)) {
                        socket.send(
                            JSON.stringify({
                                type: "ERROR",
                                message: "already in a room"
                            }),
                        );
                        return;
                    }
                    const roomId = generateRoomCode();
                    const displayName = message.displayName?.trim() || "Host";
                    createRoom(roomId, { clientId, socket, displayName });
                    clientRooms.set(clientId, roomId);
                    socket.send(
                        JSON.stringify({
                            type: "ROOM_CREATED",
                            roomId,
                        }),
                    );
                    broadcastRoomCount(roomId);
                    console.log(`Room ${roomId} created by ${displayName}`);
                    return;
                }

                if (message.type === "JOIN_REQUEST") {
                    if (!message.roomId) {
                        socket.send(
                            JSON.stringify({
                                type: "ERROR",
                                message: "roomId is required",
                            }),
                        );
                        return;
                    }
                    if (clientRooms.has(clientId)) {
                        socket.send(
                            JSON.stringify({
                                type: "ERROR",
                                message: "Already in a room",
                            }),
                        );
                        return;
                    }
                    const roomId = message.roomId.trim().toLowerCase();
                    const room = getRoom(roomId);
                    if (!room) {
                        socket.send(
                            JSON.stringify({
                                type: "ERROR",
                                message: "Room does not exist",
                            }),
                        );
                        return;
                    }
                    if (!room.host) {
                        socket.send(
                            JSON.stringify({
                                type: "ERROR",
                                message: "Host is not currently available",
                            }),
                        );
                        return;
                    }
                    const displayName = message.displayName?.trim() || "Guest";
                    room.pending.set(clientId, { clientId, socket, displayName });
                    clientRooms.set(clientId, roomId);
                    room.host.socket.send(
                        JSON.stringify({
                            type: "JOIN_REQUEST",
                            clientId,
                            displayName,
                        }),
                    );
                    console.log(`${displayName} requested to join room ${roomId}`);
                    return;
                }

                if (message.type === "JOIN_RESPONSE") {
                    const hostRoomId = clientRooms.get(clientId);
                    if (!hostRoomId || !message.targetClientId) {
                        return;
                    }
                    const room = getRoom(hostRoomId);
                    if (!room || room.host?.clientId !== clientId) {
                        return;
                    }
                    const requester = room.pending.get(message.targetClientId);
                    if (!requester) {
                        return;
                    }
                    room.pending.delete(message.targetClientId);

                    if (message.approved) {
                        room.viewers.set(requester.clientId, requester);

                        const roster = [
                            {
                                clientId: room.host.clientId,
                                displayName: room.host.displayName,
                            },
                            ...Array.from(room.viewers.values())
                                .filter((v) => v.clientId !== requester.clientId)
                                .map((v) => ({
                                    clientId: v.clientId,
                                    displayName: v.displayName,
                                })),
                        ];

                        requester.socket.send(
                            JSON.stringify({
                                type: "ROOM_JOINED",
                                roomId: hostRoomId,
                                participants: roster,
                            }),
                        );

                        const joinedPayload = JSON.stringify({
                            type: "VIEWER_JOINED",
                            clientId: requester.clientId,
                            displayName: requester.displayName,
                        });
                        room.host.socket.send(joinedPayload);
                        room.viewers.forEach((viewer) => {
                            if (viewer.clientId !== requester.clientId) {
                                viewer.socket.send(joinedPayload);
                            }
                        });

                        broadcastRoomCount(hostRoomId);
                        console.log(
                            `${requester.displayName} admitted to room ${hostRoomId}`,
                        );
                    } else {
                        requester.socket.send(
                            JSON.stringify({ type: "JOIN_DENIED" }),
                        );
                        clientRooms.delete(requester.clientId);
                        console.log(
                            `${requester.displayName} denied entry to room ${hostRoomId}`,
                        );
                    }
                    return;
                }

                if (message.type === "LEAVE_ROOM") {
                    const myRoomId = clientRooms.get(clientId);
                    if (myRoomId) {
                        handleLeave(clientId, socket, myRoomId);
                        clientRooms.delete(clientId);
                    }
                    return;
                }

                if (message.targetClientId) {
                    const targetSocket = clients.get(message.targetClientId);
                    if (!targetSocket) {
                        socket.send(
                            JSON.stringify({
                                type: "ERROR",
                                message: "target client not found"
                            }),
                        );
                        return;
                    }
                    const senderRoomId = clientRooms.get(clientId);
                    const targetRoomId = clientRooms.get(message.targetClientId);
                    if (!senderRoomId || targetRoomId !== senderRoomId) {
                        socket.send(
                            JSON.stringify({
                                type: "ERROR",
                                message: "target client is not in the same room"
                            }),
                        );
                        return;
                    }

                    targetSocket.send(JSON.stringify({
                        ...message,
                        senderClientId: clientId,
                    }));
                    return;
                }
                socket.send(
                    JSON.stringify({
                        type: "ERROR",
                        message: "Unknown message type",
                    }),
                );
            } catch {
                socket.send(
                    JSON.stringify({
                        type: "ERROR",
                        message: "invalid JSON",
                    }),
                );
            }
        })
        socket.on("close", () => {
            // A reconnect may have already replaced this clientId's socket
            // with a newer one by the time this (older) socket's close event
            // fires - if so, this event is stale and must not tear down the
            // live connection.
            if (clients.get(clientId) !== socket) {
                return;
            }
            clients.delete(clientId);

            const myRoomId = clientRooms.get(clientId);
            if (!myRoomId) {
                return;
            }
            const room = getRoom(myRoomId);
            const isConfirmedParticipant =
                room && (room.host?.clientId === clientId || room.viewers.has(clientId));

            if (isConfirmedParticipant) {
                console.log(
                    `websocket client disconnected: ${clientId} (grace period started)`,
                );
                graceTimers.set(
                    clientId,
                    setTimeout(() => {
                        graceTimers.delete(clientId);
                        handleLeave(clientId, socket, myRoomId);
                        clientRooms.delete(clientId);
                        console.log(`grace period expired for ${clientId}, left room ${myRoomId}`);
                    }, GRACE_PERIOD_MS),
                );
            } else {
                // Only a pending (not-yet-approved) request, or no real room
                // membership - nothing worth waiting around for.
                clientRooms.delete(clientId);
                console.log(`websocket client disconnected: ${clientId}`);
                if (myRoomId) {
                    handleLeave(clientId, socket, myRoomId);
                }
            }
        });
    });

    console.log("websocket server attached");
}
