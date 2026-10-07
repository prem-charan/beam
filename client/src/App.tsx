import { useEffect, useRef, useState } from "react";
import { useWebSocket } from "./hooks/useWebSocket";

function App() {
    const { send, messages, clientId } = useWebSocket();
    const [roomId, setRoomId] = useState("");
    const [roomCount, setRoomCount] = useState(0);
    const [inRoom, setInRoom] = useState(false);
    const [cameraEnabled, setCameraEnabled] = useState(false);
    const [micEnabled, setMicEnabled] = useState(false);
    const peerConnections = useRef(new Map<string, RTCPeerConnection>());
    const pendingCandidates = useRef(new Map<string, RTCIceCandidateInit[]>());
    const localStream = useRef<MediaStream | null>(null);
    const localVideoRef = useRef<HTMLVideoElement | null>(null);
    const [participants, setParticipants] = useState<
        Map<string, MediaStream | null>
    >(new Map());
    const videoElements = useRef(new Map<string, HTMLVideoElement>());

    // each effect below tracks how many messages (from the shared queue) it has
    // already processed, so a batch of several messages arriving together never
    // causes one of them to be silently skipped.
    const roomStatusProcessed = useRef(0);
    const leftProcessed = useRef(0);
    const viewerJoinedProcessed = useRef(0);
    const offerProcessed = useRef(0);
    const answerProcessed = useRef(0);
    const iceCandidateProcessed = useRef(0);

    function createRoom() {
        if (!roomId.trim()) {
            return;
        }
        send({
            type: "CREATE_ROOM",
            roomId: roomId.trim(),
        });
    }

    function joinRoom() {
        if (!roomId.trim()) {
            return;
        }
        send({
            type: "JOIN_ROOM",
            roomId: roomId.trim(),
        });
    }

    async function toggleCamera() {
        const existingTrack = localStream.current?.getVideoTracks()[0];

        if (existingTrack) {
            existingTrack.stop();
            localStream.current!.removeTrack(existingTrack);

            peerConnections.current.forEach((peerConnection) => {
                const sender = peerConnection
                    .getSenders()
                    .find((s) => s.track === existingTrack);
                if (sender) {
                    peerConnection.removeTrack(sender);
                }
            });

            if (localVideoRef.current) {
                localVideoRef.current.srcObject = localStream.current;
            }

            setCameraEnabled(false);
            console.log("camera turned off and released");
            return;
        }

        try {
            const newStream = await navigator.mediaDevices.getUserMedia({
                video: true,
            });
            const [videoTrack] = newStream.getVideoTracks();

            if (!localStream.current) {
                localStream.current = new MediaStream();
            }
            localStream.current.addTrack(videoTrack);

            if (localVideoRef.current) {
                localVideoRef.current.srcObject = localStream.current;
                localVideoRef.current.play().catch((error) => {
                    console.error("Local video play() blocked:", error);
                });
            }

            peerConnections.current.forEach((peerConnection) => {
                peerConnection.addTrack(videoTrack, localStream.current!);
            });

            setCameraEnabled(true);
            console.log("camera enabled for the first time");
        } catch (error) {
            console.error("Failed to enable camera:", error);
        }
    }

    async function toggleMic() {
        const existingTrack = localStream.current?.getAudioTracks()[0];

        if (existingTrack) {
            existingTrack.stop();
            localStream.current!.removeTrack(existingTrack);

            peerConnections.current.forEach((peerConnection) => {
                const sender = peerConnection
                    .getSenders()
                    .find((s) => s.track === existingTrack);
                if (sender) {
                    peerConnection.removeTrack(sender);
                }
            });

            setMicEnabled(false);
            console.log("mic turned off and released");
            return;
        }

        try {
            const newStream = await navigator.mediaDevices.getUserMedia({
                audio: true,
            });
            const [audioTrack] = newStream.getAudioTracks();

            if (!localStream.current) {
                localStream.current = new MediaStream();
            }
            localStream.current.addTrack(audioTrack);

            peerConnections.current.forEach((peerConnection) => {
                peerConnection.addTrack(audioTrack, localStream.current!);
            });

            setMicEnabled(true);
            console.log("mic enabled for the first time");
        } catch (error) {
            console.error("Failed to enable mic:", error);
        }
    }

    function leaveRoom() {
        send({ type: "LEAVE_ROOM" });

        peerConnections.current.forEach((peerConnection) => {
            peerConnection.close();
        });
        peerConnections.current.clear();
        pendingCandidates.current.clear();
        if (localStream.current) {
            localStream.current.getTracks().forEach((track) => track.stop());
            localStream.current = null;
        }
        if (localVideoRef.current) {
            localVideoRef.current.srcObject = null;
        }

        setRoomId("");
        setRoomCount(0);
        setInRoom(false);
        setCameraEnabled(false);
        setMicEnabled(false);
        setParticipants(new Map());
        console.log("left room, cleaned up all connections and media");
    }

    useEffect(() => {
        window.addEventListener("pagehide", leaveRoom);
        return () => {
            window.removeEventListener("pagehide", leaveRoom);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        const newMessages = messages.slice(roomStatusProcessed.current);
        roomStatusProcessed.current = messages.length;

        for (const message of newMessages) {
            if (
                message.type === "ROOM_CREATED" ||
                message.type === "ROOM_JOINED"
            ) {
                queueMicrotask(() => setInRoom(true));
                continue;
            }

            if (
                message.type === "ROOM_COUNT" &&
                typeof message.count === "number"
            ) {
                const count = message.count;
                queueMicrotask(() => setRoomCount(count));
            }
        }
    }, [messages]);

    useEffect(() => {
        const newMessages = messages.slice(leftProcessed.current);
        leftProcessed.current = messages.length;

        for (const message of newMessages) {
            if (message.type === "HOST_LEFT") {
                console.log("host left the room, cleaning up");
                queueMicrotask(() => leaveRoom());
                continue;
            }

            if (message.type === "VIEWER_LEFT" && message.clientId) {
                const viewerClientId = message.clientId;
                console.log("viewer left:", viewerClientId);

                const peerConnection =
                    peerConnections.current.get(viewerClientId);
                if (peerConnection) {
                    peerConnection.close();
                    peerConnections.current.delete(viewerClientId);
                }
                pendingCandidates.current.delete(viewerClientId);

                queueMicrotask(() => {
                    setParticipants((prev) => {
                        const next = new Map(prev);
                        next.delete(viewerClientId);
                        return next;
                    });
                });
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [messages]);

    useEffect(() => {
        const newMessages = messages.slice(viewerJoinedProcessed.current);
        viewerJoinedProcessed.current = messages.length;

        for (const message of newMessages) {
            if (message.type !== "VIEWER_JOINED") {
                continue;
            }
            if (!message.clientId) {
                continue;
            }
            if (!clientId) {
                continue;
            }

            const remoteClientId = message.clientId;
            console.log(
                "new participant joined, creating peerconnection:",
                remoteClientId,
            );
            const peerConnection = new RTCPeerConnection({
                iceServers: [
                    {
                        urls: "stun:stun.l.google.com:19302",
                    },
                ],
            });

            peerConnections.current.set(remoteClientId, peerConnection);
            console.log("peerConnection created:", peerConnection);

            queueMicrotask(() => {
                setParticipants((prev) => {
                    const next = new Map(prev);
                    next.set(remoteClientId, null);
                    return next;
                });
            });

            peerConnection.onicecandidate = (event) => {
                console.log("ICE event:", event);
                if (!event.candidate) {
                    console.log("ICE gathering complete");
                    return;
                }
                send({
                    type: "ICE_CANDIDATE",
                    targetClientId: remoteClientId,
                    candidate: event.candidate,
                });
                console.log("ICE candidate sent to:", remoteClientId);
            };

            peerConnection.onicegatheringstatechange = () => {
                console.log(
                    "ICE gathering state:",
                    peerConnection.iceGatheringState,
                );
            };

            peerConnection.oniceconnectionstatechange = () => {
                console.log(
                    "ICE connection state:",
                    peerConnection.iceConnectionState,
                );
            };

            peerConnection.onconnectionstatechange = () => {
                console.log(
                    "peer connection state:",
                    peerConnection.connectionState,
                );
            };
            peerConnection.onicecandidateerror = (event) => {
                console.error("ICE candidate error:", event);
            };

            peerConnection.ontrack = (event) => {
                console.log("received remote track:", event.track);
                const [remoteStream] = event.streams;
                setParticipants((prev) => {
                    const next = new Map(prev);
                    next.set(remoteClientId, remoteStream);
                    return next;
                });

                remoteStream.onremovetrack = () => {
                    console.log(
                        "track removed from stream for:",
                        remoteClientId,
                        "remaining video tracks:",
                        remoteStream.getVideoTracks().length,
                    );
                    const el = videoElements.current.get(remoteClientId);
                    if (el && remoteStream.getVideoTracks().length === 0) {
                        el.load();
                    }
                };
            };

            const negotiate = async () => {
                try {
                    console.log("negotiating with:", remoteClientId);
                    const offer = await peerConnection.createOffer();
                    await peerConnection.setLocalDescription(offer);
                    send({
                        type: "OFFER",
                        targetClientId: remoteClientId,
                        offer: peerConnection.localDescription,
                    });
                    console.log("OFFER (re)sent to:", remoteClientId);
                } catch (error) {
                    console.error("negotiation failed:", error);
                }
            };
            peerConnection.onnegotiationneeded = negotiate;

            if (localStream.current) {
                localStream.current.getTracks().forEach((track) => {
                    console.log(
                        "adding existing track for new participant:",
                        track.kind,
                        track.readyState,
                        track.enabled,
                    );
                    peerConnection.addTrack(track, localStream.current!);
                });
                // addTrack above triggers onnegotiationneeded automatically
            } else {
                console.log(
                    "no local media yet, negotiating an empty connection so the other side can add their own media later",
                );
                negotiate();
            }
        }
    }, [messages, clientId, send]);

    useEffect(() => {
        const newMessages = messages.slice(offerProcessed.current);
        offerProcessed.current = messages.length;

        for (const message of newMessages) {
            if (message.type !== "OFFER") {
                continue;
            }
            if (!message.offer) {
                continue;
            }
            if (!message.targetClientId) {
                continue;
            }
            if (!message.senderClientId) {
                continue;
            }

            const remoteClientId = message.senderClientId;
            const offer = message.offer;
            const existingConnection =
                peerConnections.current.get(remoteClientId);
            const peerConnection =
                existingConnection ??
                new RTCPeerConnection({
                    iceServers: [
                        {
                            urls: "stun:stun.l.google.com:19302",
                        },
                    ],
                });

            if (!existingConnection) {
                console.log(
                    "OFFER received (new connection) from:",
                    remoteClientId,
                );
                peerConnections.current.set(remoteClientId, peerConnection);

                queueMicrotask(() => {
                    setParticipants((prev) => {
                        const next = new Map(prev);
                        next.set(remoteClientId, null);
                        return next;
                    });
                });

                peerConnection.onicecandidate = (event) => {
                    console.log("ICE event:", event);
                    if (!event.candidate) {
                        console.log("ICE gathering complete");
                        return;
                    }

                    send({
                        type: "ICE_CANDIDATE",
                        targetClientId: remoteClientId,
                        candidate: event.candidate,
                    });
                    console.log("ICE candidate sent to:", remoteClientId);
                };

                peerConnection.onicegatheringstatechange = () => {
                    console.log(
                        "ICE gathering state:",
                        peerConnection.iceGatheringState,
                    );
                };

                peerConnection.oniceconnectionstatechange = () => {
                    console.log(
                        "ICE connection state:",
                        peerConnection.iceConnectionState,
                    );
                };

                peerConnection.onconnectionstatechange = () => {
                    console.log(
                        "peer connection state:",
                        peerConnection.connectionState,
                    );
                };

                peerConnection.onicecandidateerror = (event) => {
                    console.error("ICE candidate error:", event);
                };

                peerConnection.onnegotiationneeded = async () => {
                    try {
                        console.log("negotiating with:", remoteClientId);
                        const newOffer = await peerConnection.createOffer();
                        await peerConnection.setLocalDescription(newOffer);
                        send({
                            type: "OFFER",
                            targetClientId: remoteClientId,
                            offer: peerConnection.localDescription,
                        });
                        console.log("OFFER (re)sent to:", remoteClientId);
                    } catch (error) {
                        console.error("negotiation failed:", error);
                    }
                };

                peerConnection.ontrack = (event) => {
                    console.log("received remote track:", event.track);
                    const [remoteStream] = event.streams;
                    setParticipants((prev) => {
                        const next = new Map(prev);
                        next.set(remoteClientId, remoteStream);
                        return next;
                    });

                    remoteStream.onremovetrack = () => {
                        console.log(
                            "track removed from stream for:",
                            remoteClientId,
                            "remaining video tracks:",
                            remoteStream.getVideoTracks().length,
                        );
                        const el = videoElements.current.get(remoteClientId);
                        if (el && remoteStream.getVideoTracks().length === 0) {
                            el.load();
                        }
                    };
                };
            } else {
                console.log(
                    "OFFER received (renegotiation) from:",
                    remoteClientId,
                );
            }

            (async () => {
                try {
                    await peerConnection.setRemoteDescription(offer);
                    console.log("remote description set");
                    const pending =
                        pendingCandidates.current.get(remoteClientId) ?? [];

                    for (const candidate of pending) {
                        await peerConnection.addIceCandidate(candidate);
                        console.log(
                            "queued ICE candidate added from:",
                            remoteClientId,
                        );
                    }
                    pendingCandidates.current.delete(remoteClientId);

                    const answer = await peerConnection.createAnswer();

                    await peerConnection.setLocalDescription(answer);
                    console.log(
                        "local answer description set:",
                        peerConnection.localDescription,
                    );

                    send({
                        type: "ANSWER",
                        targetClientId: remoteClientId,
                        answer: peerConnection.localDescription,
                    });

                    console.log("ANSWER sent to:", remoteClientId);
                } catch (error) {
                    console.error("failed to create answer:", error);
                }
            })();
        }
    }, [messages, clientId, send]);

    useEffect(() => {
        const newMessages = messages.slice(answerProcessed.current);
        answerProcessed.current = messages.length;

        for (const message of newMessages) {
            if (message.type !== "ANSWER") {
                continue;
            }
            if (!message.answer) {
                continue;
            }
            if (!message.senderClientId) {
                continue;
            }

            const remoteClientId = message.senderClientId;
            const answer = message.answer;
            console.log("ANSWER received from:", remoteClientId);
            const peerConnection = peerConnections.current.get(remoteClientId);
            if (!peerConnection) {
                console.log("No peer connection found for:", remoteClientId);
                continue;
            }

            (async () => {
                try {
                    await peerConnection.setRemoteDescription(answer);

                    console.log("remote answer description set");
                    const pending =
                        pendingCandidates.current.get(remoteClientId) ?? [];

                    for (const candidate of pending) {
                        await peerConnection.addIceCandidate(candidate);

                        console.log(
                            "queued ICE candidate added from:",
                            remoteClientId,
                        );
                    }

                    pendingCandidates.current.delete(remoteClientId);
                } catch (error) {
                    console.error("failed to set answer:", error);
                }
            })();
        }
    }, [messages]);

    useEffect(() => {
        const newMessages = messages.slice(iceCandidateProcessed.current);
        iceCandidateProcessed.current = messages.length;

        for (const message of newMessages) {
            if (message.type !== "ICE_CANDIDATE") {
                continue;
            }
            if (!message.senderClientId) {
                continue;
            }
            if (!message.candidate) {
                continue;
            }

            const remoteClientId = message.senderClientId;
            const candidate = message.candidate;
            const peerConnection = peerConnections.current.get(remoteClientId);

            if (!peerConnection) {
                console.log("No peer connection found for:", remoteClientId);
                continue;
            }

            (async () => {
                try {
                    if (!peerConnection.remoteDescription) {
                        console.log(
                            "Remote description not ready. Queueing ICE candidate from:",
                            remoteClientId,
                        );

                        const candidates =
                            pendingCandidates.current.get(remoteClientId) ?? [];

                        candidates.push(candidate);

                        pendingCandidates.current.set(
                            remoteClientId,
                            candidates,
                        );

                        return;
                    }

                    await peerConnection.addIceCandidate(candidate);

                    console.log("ICE candidate added from:", remoteClientId);
                } catch (error) {
                    console.error("Failed to add ICE candidate:", error);
                }
            })();
        }
    }, [messages]);

    return (
        <div>
            <h1>Live streaming app</h1>

            <input
                type="text"
                placeholder="Enter room Id"
                value={roomId}
                onChange={(event) => setRoomId(event.target.value)}
            />

            <button onClick={createRoom}>Create Room</button>

            <button onClick={joinRoom}>Join Room</button>

            <button onClick={leaveRoom}>Leave Room</button>

            <button onClick={toggleCamera}>
                Camera: {cameraEnabled ? "On" : "Off"}
            </button>

            <button onClick={toggleMic}>
                Mic: {micEnabled ? "On" : "Off"}
            </button>

            {inRoom && <p>People in room: {roomCount}</p>}

            <div style={{ display: "flex", gap: "1rem", marginTop: "1rem" }}>
                <div>
                    <h3>Your camera (local preview)</h3>
                    <video
                        ref={localVideoRef}
                        autoPlay
                        playsInline
                        muted
                        style={{
                            width: "320px",
                            background: "#000",
                            transform: "scaleX(-1)",
                        }}
                    />
                </div>

                {Array.from(participants.entries()).map(([id, stream]) => (
                    <div key={id}>
                        <h3>Participant {id.slice(0, 8)}</h3>
                        <video
                            ref={(el) => {
                                if (el) {
                                    videoElements.current.set(id, el);
                                    if (el.srcObject !== stream) {
                                        el.srcObject = stream;
                                        el.play().catch((error) => {
                                            console.error(
                                                "tile video play() blocked:",
                                                error,
                                            );
                                        });
                                    }
                                } else {
                                    videoElements.current.delete(id);
                                }
                            }}
                            autoPlay
                            playsInline
                            style={{ width: "320px", background: "#000" }}
                        />
                    </div>
                ))}
            </div>

            <h2>Server Message</h2>

            {messages.length > 0 && (
                <pre>
                    {JSON.stringify(messages[messages.length - 1], null, 2)}
                </pre>
            )}
        </div>
    );
}

export default App;
