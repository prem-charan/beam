import type { WebSocket } from "ws";

export type Participant = {
    clientId: string;
    socket: WebSocket;
    displayName: string;
};

type Room = {
    host: Participant | null;
    viewers: Map<string, Participant>;
    pending: Map<string, Participant>;
};

const rooms = new Map<string, Room>();

// Excludes visually ambiguous characters (0/O, 1/I/L) so a spoken or
// handwritten code is never misread.
const CODE_CHARS = "abcdefghjkmnpqrstuvwxyz23456789";

export function generateRoomCode(): string {
    let code: string;
    do {
        code = Array.from(
            { length: 6 },
            () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)],
        ).join("");
    } while (rooms.has(code));
    return code;
}

export function createRoom(roomId: string, host: Participant) {
    if (rooms.has(roomId)) {
        throw new Error("room already exists");
    }

    rooms.set(roomId, {
        host,
        viewers: new Map(),
        pending: new Map(),
    });
}

export function getRoom(roomId: string) {
    return rooms.get(roomId);
}

export function deleteRoom(roomId: string) {
    rooms.delete(roomId);
}
