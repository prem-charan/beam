import { WebSocketServer } from "ws";
import type { Server } from "http";
import { createRoom, deleteRoom, getRoom } from "./rooms.js";
import { randomUUID } from "crypto";
import { WebSocket } from "ws";
import type { Message } from "@live-streaming-app/shared";

const clients = new Map<string, WebSocket>(); // mapping clients to websocket
const clientRooms = new Map<string, string>(); // mapping clients to rooms

export function setupWebSocket(server: Server) {
    const wss = new WebSocketServer({ server });

    wss.on("connection", (socket) => {
        const clientId = randomUUID();
        clients.set(clientId, socket);
        let currentRoomId: string | null = null;
        console.log(`websocket client connected: ${clientId}`);
        socket.send(
            JSON.stringify({
                type: "CONNECTED",
                clientId
            }),
        );
        socket.on("message", (data) => {
            try {
                const message: Message = JSON.parse(data.toString());
                if (message.type === "CREATE_ROOM") {
                    if (!message.roomId) {
                        socket.send(
                            JSON.stringify({ 
                                type: "ERROR",
                                message: "roomId is required",
                            }),
                        );
                        return;
                    }
                    if (currentRoomId) {
                        socket.send(
                            JSON.stringify({
                                type: "ERROR",
                                message: "already in a room"
                            }),
                        );
                        return;
                    }
                    createRoom(message.roomId, socket);
                    currentRoomId = message.roomId;
                    clientRooms.set(clientId, message.roomId);
                    socket.send(
                        JSON.stringify({
                            type: "ROOM_CREATED",
                            roomId: message.roomId,
                        }),
                    );
                    console.log(`Room ${message.roomId} created`);
                    return;
                }
                if (message.type === "JOIN_ROOM") {
                    if (!message.roomId) {
                        socket.send(
                            JSON.stringify({
                                type: "ERROR",
                                message: "roomId is required",
                            }),
                        );
                        return;
                    }
                    if (currentRoomId) {
                            socket.send(
                                JSON.stringify({
                                    type: "ERROR",
                                    message: "Already in a room",
                                }),
                            );
                            return;
                    }
                    const room = getRoom(message.roomId);
                    if (!room) {
                        socket.send(
                            JSON.stringify({
                                type: "ERROR",
                                message: "Room does not exist",
                            }),
                        );
                        return;
                    }
                    room.viewers.add(socket);
                    currentRoomId = message.roomId;
                    clientRooms.set(clientId, message.roomId);
                    socket.send(
                        JSON.stringify({
                            type: "ROOM_JOINED",
                            roomId: message.roomId,
                        }),
                    );
                    if (room.host) {
                        room.host.send(
                            JSON.stringify({
                                type: "VIEWER_JOINED",
                                clientId
                            }),
                        );
                    }
                    console.log(`viewer joined room ${message.roomId}`);
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
                    const targetRoomId = clientRooms.get(message.targetClientId);
                    if (!currentRoomId || targetRoomId !== currentRoomId) {
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
            clients.delete(clientId);
            clientRooms.delete(clientId);
            console.log(`websocket client disconnected: ${clientId}`);
            if (!currentRoomId) {
                return;
            }
            const room = getRoom(currentRoomId);
            if (!room) {
                return;
            }
            if (room.host === socket) {
                room.host = null;
                console.log(`host left room ${currentRoomId}`);   
            } else {
                room.viewers.delete(socket);
                console.log(`viewer left room ${currentRoomId}`);
            }
            if (!room.host && room.viewers.size === 0) {
                deleteRoom(currentRoomId);
                console.log(`room ${currentRoomId} deleted`);
            }
        });
    });

    console.log("websocket server attached");
}
