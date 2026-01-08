const {
  verifyPoW,
  verifySignature,
  createPublicKey,
} = require("../core/security");
const crypto = require("crypto");
const { MAX_RELAY_HOPS, ENABLE_CHAT, CHAT_RATE_LIMIT } = require("../config/constants");
const { BloomFilterManager } = require("../state/bloom");
const { generateScreenname } = require("../utils/name-generator");

class MessageHandler {
  constructor(
    peerManager,
    diagnostics,
    relayCallback,
    broadcastCallback,
    chatCallback,
    chatSystemFn
  ) {
    this.peerManager = peerManager;
    this.diagnostics = diagnostics;
    this.relayCallback = relayCallback;
    this.broadcastCallback = broadcastCallback;
    this.chatCallback = chatCallback;
    this.chatSystemFn = chatSystemFn;
    this.bloomFilter = new BloomFilterManager();
    this.bloomFilter.start();
    this.chatRateLimits = new Map();
  }

  handleMessage(msg, sourceSocket) {
    if (!validateMessage(msg)) {
      return;
    }

    if (msg.type === "HEARTBEAT") {
      this.handleHeartbeat(msg, sourceSocket);
    } else if (msg.type === "LEAVE") {
      this.handleLeave(msg, sourceSocket);
    } else if (msg.type === "CHAT") {
      this.handleChat(msg, sourceSocket);
    }
  }

  handleHeartbeat(msg, sourceSocket) {
    this.diagnostics.increment("heartbeatsReceived");
    const { id, seq, hops, nonce, sig } = msg;

    // Optimization: Check for duplicates BEFORE verifyPoW (CPU intensive)
    const stored = this.peerManager.getPeer(id);
    if (stored && seq <= stored.seq) {
      this.diagnostics.increment("duplicateSeq");
      return;
    }

    if (!verifyPoW(id, nonce)) {
      this.diagnostics.increment("invalidPoW");
      return;
    }

    if (!sig) return;

    try {
      // Check if we can accept new peers (only matters for new peers)
      if (!stored && !this.peerManager.canAcceptPeer(id)) return;

      // Derive public key on-demand from peer ID
      const key = createPublicKey(id);

      if (!verifySignature(`seq:${seq}`, sig, key)) {
        this.diagnostics.increment("invalidSig");
        return;
      }

      if (hops === 0) {
        sourceSocket.peerId = id;
      }

      const getIp = (sock) => {
        if (sock.remoteAddress) return sock.remoteAddress;
        if (sock.rawStream && sock.rawStream.remoteHost)
          return sock.rawStream.remoteHost;
        if (sock.rawStream && sock.rawStream.remoteAddress)
          return sock.rawStream.remoteAddress;
        return null;
      };

      const ip = hops === 0 ? getIp(sourceSocket) : null;
      const wasNew = this.peerManager.addOrUpdatePeer(id, seq, ip);

      if (wasNew) {
        this.diagnostics.increment("newPeersAdded");
        this.broadcastCallback();
        if (ENABLE_CHAT && this.chatSystemFn && hops === 0) {
          this.chatSystemFn({
            type: "SYSTEM",
            content: `Connection established with Node [${generateScreenname(id)}]`,
            timestamp: Date.now(),
          });
        }
      }

      // Only relay if we haven't already relayed this message (bloom filter check)
      if (hops < MAX_RELAY_HOPS && !this.bloomFilter.hasRelayed(id, seq)) {
        this.bloomFilter.markRelayed(id, seq);
        this.diagnostics.increment("heartbeatsRelayed");
        this.relayCallback({ ...msg, hops: hops + 1 }, sourceSocket);
      }
    } catch (e) {
      return;
    }
  }

  handleLeave(msg, sourceSocket) {
    this.diagnostics.increment("leaveMessages");
    const { id, hops, sig } = msg;

    if (!sig) return;

    // Only process leave messages for peers we know about
    if (!this.peerManager.hasPeer(id)) return;

    // Derive public key on-demand from peer ID
    const key = createPublicKey(id);

    if (!verifySignature(`type:LEAVE:${id}`, sig, key)) {
      this.diagnostics.increment("invalidSig");
      return;
    }

    if (this.peerManager.hasPeer(id)) {
      this.peerManager.removePeer(id);
      this.broadcastCallback();

      if (ENABLE_CHAT && this.chatSystemFn && hops === 0) {
        this.chatSystemFn({
          type: "SYSTEM",
          content: `Node [${generateScreenname(id)}] disconnected.`,
          timestamp: Date.now(),
        });
      }

      // Use id:leave as key for LEAVE messages
      if (hops < MAX_RELAY_HOPS && !this.bloomFilter.hasRelayed(id, "leave")) {
        this.bloomFilter.markRelayed(id, "leave");
        this.relayCallback({ ...msg, hops: hops + 1 }, sourceSocket);
      }
    }
  }

  handleChat(msg, sourceSocket) {
    const { scope, sender, id, sig, hops } = msg;

    // Rate Limiting (apply to all chat messages)
    const now = Date.now();
    let rateData = this.chatRateLimits.get(sender);
    
    if (!rateData || now - rateData.windowStart > 10000) {
        // Reset window
        rateData = { count: 0, windowStart: now };
    }

    if (rateData.count >= 5) {
        return; // Drop message
    }

    if (!scope || scope === 'LOCAL') {
        // Identity Verification: Ensure the sender matches the authenticated socket
        if (!sourceSocket.peerId || sourceSocket.peerId !== sender) {
            return;
        }

        rateData.count++;
        this.chatRateLimits.set(sender, rateData);

        if (this.chatCallback) {
            this.chatCallback(msg);
        }
    } else if (scope === 'GLOBAL') {
        if (!sig || !id) return;

        // Integrity Check: Ensure ID matches content/timestamp
        // This binds the signature (which signs ID) to the content
        const idBase = sender + msg.content + msg.timestamp;
        const computedId = crypto.createHash('sha256').update(idBase).digest('hex');
        
        if (computedId !== id) {
            this.diagnostics.increment("invalidSig"); // Reuse metric for integrity failure
            return;
        }

        // Timestamp Check: Prevent replays beyond Bloom filter window
        // Allow 1 minute drift/delay
        if (Math.abs(now - msg.timestamp) > 60000) {
             return; 
        }

        // Check signature
        const key = createPublicKey(sender);
        if (!verifySignature(`chat:${id}`, sig, key)) {
            this.diagnostics.increment("invalidSig");
            return;
        }

        // Deduplication
        if (this.bloomFilter.hasRelayed(id, "chat")) {
            return;
        }
        this.bloomFilter.markRelayed(id, "chat");

        rateData.count++;
        this.chatRateLimits.set(sender, rateData);

        if (this.chatCallback) {
            this.chatCallback(msg);
        }

        // Relay
        if (hops < MAX_RELAY_HOPS) {
            this.relayCallback({ ...msg, hops: hops + 1 }, sourceSocket);
        }
    }
  }
}

const validateMessage = (msg) => {
  if (!msg || typeof msg !== "object") return false;
  if (!msg.type) return false;

  const msgSize = JSON.stringify(msg).length;
  if (msgSize > require("../config/constants").MAX_MESSAGE_SIZE) return false;

  if (msg.type === "HEARTBEAT") {
    const allowedFields = ["type", "id", "seq", "hops", "nonce", "sig"];
    const fields = Object.keys(msg);
    return (
      fields.every((f) => allowedFields.includes(f)) &&
      msg.id &&
      typeof msg.seq === "number" &&
      typeof msg.hops === "number" &&
      msg.nonce &&
      msg.sig
    );
  }

  if (msg.type === "LEAVE") {
    const allowedFields = ["type", "id", "hops", "sig"];
    const fields = Object.keys(msg);
    return (
      fields.every((f) => allowedFields.includes(f)) &&
      msg.id &&
      typeof msg.hops === "number" &&
      msg.sig
    );
  }

  if (msg.type === "CHAT") {
    const allowedFields = ['type', 'sender', 'content', 'timestamp', 'scope', 'id', 'sig', 'hops'];
    const fields = Object.keys(msg);
    return fields.every(f => allowedFields.includes(f)) &&
        msg.sender && 
        msg.content && typeof msg.content === 'string' && msg.content.length <= 140 &&
        typeof msg.timestamp === 'number';
  }

  return false;
};

module.exports = { MessageHandler, validateMessage };
