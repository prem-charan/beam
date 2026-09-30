
export type Message = {
    type:
        | "CREATE_ROOM"
        | "JOIN_ROOM" 
        | "CONNECTED"
        | "ROOM_CREATED" 
        | "ROOM_JOINED"
        | "VIEWER_JOINED"
        | "OFFER"
        | "ANSWER"
        | "ICE_CANDIDATE"
        | "LEAVE_ROOM"
        | "HOST_LEFT"
        | "VIEWER_LEFT"
        | "ROOM_COUNT"
        | "ERROR";
    roomId?: string;
    clientId?: string;
    senderClientId?: string;
    targetClientId?: string;
    message?: string;
    offer?: RTCSessionDescriptionInit;
    answer?: RTCSessionDescriptionInit;
    candidate?: RTCIceCandidateInit;
    count?: number;
};