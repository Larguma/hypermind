const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { signMessage } = require("../core/security");
const { ENABLE_CHAT, ENABLE_MAP, ENABLE_THEMES, CHAT_RATE_LIMIT, VISUAL_LIMIT } = require("../config/constants");

const HTML_TEMPLATE = fs.readFileSync(
    path.join(__dirname, "../../public/index.html"),
    "utf-8"
);

const setupRoutes = (app, identity, peerManager, swarm, sseManager, diagnostics) => {
    app.use(express.json());

    app.get("/", (req, res) => {
        const count = peerManager.size;
        const directPeers = swarm.getSwarm().connections.size;

        const html = HTML_TEMPLATE
            .replace(/\{\{COUNT\}\}/g, count)
            .replace(/\{\{ID\}\}/g, "..." + identity.id.slice(-8))
            .replace(/\{\{DIRECT\}\}/g, directPeers)
            .replace(/\{\{MAP_CLASS\}\}/g, ENABLE_MAP ? '' : 'hidden')
            .replace(/\{\{THEMES_CLASS\}\}/g, ENABLE_THEMES ? '' : 'hidden')
            .replace(/\{\{VISUAL_LIMIT\}\}/g, VISUAL_LIMIT);

        res.send(html);
    });

    app.get("/events", (req, res) => {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders();

        sseManager.addClient(res);

        const data = JSON.stringify({
            count: peerManager.size,
            totalUnique: peerManager.totalUniquePeers,
            direct: swarm.getSwarm().connections.size,
            id: identity.id,
            diagnostics: diagnostics.getStats(),
            chatEnabled: ENABLE_CHAT,
            peers: peerManager.getPeersWithIps()
        });
        res.write(`data: ${data}\n\n`);

        req.on("close", () => {
            sseManager.removeClient(res);
        });
    });

    app.get("/api/stats", (req, res) => {
        res.json({
            count: peerManager.size,
            totalUnique: peerManager.totalUniquePeers,
            direct: swarm.getSwarm().connections.size,
            id: identity.id,
            diagnostics: diagnostics.getStats(),
            chatEnabled: ENABLE_CHAT,
            peers: peerManager.getPeersWithIps()
        });
    });

    let chatHistory = []; // Store timestamps of recent messages

    app.post("/api/chat", (req, res) => {
        if (!ENABLE_CHAT) {
            return res.status(403).json({ error: "Chat disabled" });
        }

        const now = Date.now();
        // Clean up old timestamps (older than CHAT_RATE_LIMIT)
        chatHistory = chatHistory.filter(time => now - time < CHAT_RATE_LIMIT);

        if (chatHistory.length >= 5) {
            return res.status(429).json({ error: `Rate limit exceeded: Max 5 messages per ${CHAT_RATE_LIMIT / 1000} seconds` });
        }
        
        chatHistory.push(now);

        const { content, scope = 'LOCAL' } = req.body;
        if (!content || typeof content !== 'string' || content.length > 140) {
            return res.status(400).json({ error: "Invalid content" });
        }
        
        if (scope !== 'LOCAL' && scope !== 'GLOBAL') {
             return res.status(400).json({ error: "Invalid scope" });
        }

        const timestamp = Date.now();
        // Create a unique ID that depends on content to prevent replay/duplicates
        const idBase = identity.id + content + timestamp;
        const msgId = crypto.createHash('sha256').update(idBase).digest('hex');

        const msg = {
            type: "CHAT",
            id: msgId,
            sender: identity.id,
            content: content,
            timestamp: timestamp,
            scope: scope,
            hops: 0
        };

        if (scope === 'GLOBAL') {
             msg.sig = signMessage(`chat:${msgId}`, identity.privateKey);
        }

        swarm.broadcastChat(msg);
        sseManager.broadcast(msg);

        res.json({ success: true });
    });

    app.use(express.static(path.join(__dirname, "../../public")));
}

module.exports = { setupRoutes };
