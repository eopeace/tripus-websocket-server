// server.js - TripUs AI WebSocket Server (Railway Compatible)
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const httpServer = createServer(app);

// Temporary: Use memory instead of Redis for testing
const rooms = new Map(); // Store room data in memory

// Socket.IO server with CORS
const io = new Server(httpServer, {
  cors: {
    origin: "*", 
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling']
});

// Middleware
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  try {
    res.json({ 
      status: 'healthy', 
      connections: io.engine.clientsCount,
      timestamp: new Date().toISOString(),
      server: 'tripus-websocket-server',
      version: '1.0.0'
    });
  } catch (error) {
    console.error('Health check error:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: 'TripUs AI WebSocket Server', 
    status: 'running',
    endpoints: {
      health: '/health',
      websocket: '/socket.io/'
    }
  });
});

// Trip session management
class TripSession {
  constructor(tripId) {
    this.tripId = tripId;
    this.members = new Map();
    this.leader = null;
    this.destination = null;
    this.lastUpdate = Date.now();
    this.breadcrumbs = new Map(); // Store trail for each member
  }

  addMember(userId, socketId, userData) {
    this.members.set(userId, {
      socketId,
      userId,
      name: userData.name,
      avatar: userData.avatar,
      location: null,
      speed: 0,
      heading: 0,
      status: 'active',
      lastSeen: Date.now(),
      isLeader: false,
      hasArrived: false,
    });
    
    // Initialize breadcrumb trail for new member
    this.breadcrumbs.set(userId, []);
  }

  removeMember(userId) {
    this.members.delete(userId);
    this.breadcrumbs.delete(userId);
    
    // If leader left, assign new leader
    if (this.leader === userId && this.members.size > 0) {
      const newLeader = this.members.keys().next().value;
      this.setLeader(newLeader);
    }
  }

  setLeader(userId) {
    // Reset previous leader
    if (this.leader) {
      const prevLeader = this.members.get(this.leader);
      if (prevLeader) prevLeader.isLeader = false;
    }
    
    // Set new leader
    this.leader = userId;
    const leader = this.members.get(userId);
    if (leader) leader.isLeader = true;
  }

  updateLocation(userId, locationData) {
    const member = this.members.get(userId);
    if (!member) return null;

    const prevLocation = member.location;
    
    member.location = {
      lat: locationData.lat,
      lng: locationData.lng,
      accuracy: locationData.accuracy,
      timestamp: Date.now(),
    };
    
    member.speed = locationData.speed || 0;
    member.heading = locationData.heading || 0;
    member.lastSeen = Date.now();
    
    // Update status based on speed
    if (member.speed === 0) {
      member.status = 'stopped';
    } else if (member.speed < 5) {
      member.status = 'walking';
    } else if (member.speed < 80) {
      member.status = 'driving';
    } else {
      member.status = 'driving-fast';
    }

    // Add to breadcrumb trail (keep last 100 points)
    const breadcrumbs = this.breadcrumbs.get(userId);
    if (breadcrumbs) {
      breadcrumbs.push({
        lat: locationData.lat,
        lng: locationData.lng,
        timestamp: Date.now(),
      });
      
      if (breadcrumbs.length > 100) {
        breadcrumbs.shift();
      }
    }

    // Check if arrived at destination
    if (this.destination && !member.hasArrived) {
      const distance = calculateDistance(
        member.location.lat,
        member.location.lng,
        this.destination.lat,
        this.destination.lng
      );
      
      if (distance < 0.1) { // Within 100 meters
        member.hasArrived = true;
      }
    }

    this.lastUpdate = Date.now();
    return member;
  }

  getMemberStats() {
    let arrived = 0;
    let enRoute = 0;
    let offline = 0;

    const now = Date.now();
    
    for (const [userId, member] of this.members) {
      if (member.hasArrived) {
        arrived++;
      } else if (now - member.lastSeen > 60000) { // 1 minute timeout
        offline++;
        member.status = 'offline';
      } else {
        enRoute++;
      }
    }

    return { arrived, enRoute, offline, total: this.members.size };
  }

  getPublicData() {
    const members = Array.from(this.members.values()).map(member => ({
      userId: member.userId,
      name: member.name,
      avatar: member.avatar,
      location: member.location,
      speed: member.speed,
      heading: member.heading,
      status: member.status,
      isLeader: member.isLeader,
      hasArrived: member.hasArrived,
      lastSeen: member.lastSeen,
    }));

    return {
      tripId: this.tripId,
      leader: this.leader,
      destination: this.destination,
      members,
      stats: this.getMemberStats(),
      lastUpdate: this.lastUpdate,
    };
  }

  getBreadcrumbs(userId) {
    return this.breadcrumbs.get(userId) || [];
  }
}

// Active trip sessions
const tripSessions = new Map();

// Helper functions
function calculateDistance(lat1, lng1, lat2, lng2) {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng/2) * Math.sin(dLng/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// Authentication middleware for Socket.IO (simplified for testing)
io.use(async (socket, next) => {
  try {
    // For testing, accept any connection
    socket.userId = socket.handshake.auth.userId || 'demo-user-' + Math.random().toString(36).substr(2, 9);
    socket.userName = socket.handshake.auth.userName || 'Demo User';
    socket.userAvatar = socket.handshake.auth.userAvatar || '';
    socket.tripId = socket.handshake.auth.tripId || 'demo-trip';
    
    console.log(`User ${socket.userId} authenticating for trip ${socket.tripId}`);
    next();
  } catch (err) {
    console.error('Authentication error:', err);
    next(new Error('Authentication failed'));
  }
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log(`User ${socket.userId} connected to trip ${socket.tripId}`);
  
  try {
    // Join trip room
    socket.join(`trip:${socket.tripId}`);
    
    // Get or create trip session
    let session = tripSessions.get(socket.tripId);
    if (!session) {
      session = new TripSession(socket.tripId);
      tripSessions.set(socket.tripId, session);
      console.log(`Created new trip session: ${socket.tripId}`);
    }
    
    // Add member to session
    session.addMember(socket.userId, socket.id, {
      name: socket.userName,
      avatar: socket.userAvatar,
    });
    
    // Notify others that user joined
    socket.to(`trip:${socket.tripId}`).emit('member:joined', {
      userId: socket.userId,
      name: socket.userName,
      avatar: socket.userAvatar,
    });
    
    // Send current trip state to new member
    socket.emit('trip:state', session.getPublicData());
    
    // Location update handler
    socket.on('location:update', (locationData) => {
      try {
        const member = session.updateLocation(socket.userId, locationData);
        
        if (member) {
          // Broadcast location update to all trip members
          io.to(`trip:${socket.tripId}`).emit('member:location', {
            userId: socket.userId,
            location: member.location,
            speed: member.speed,
            heading: member.heading,
            status: member.status,
            hasArrived: member.hasArrived,
          });
          
          // Check for alerts (e.g., member stopped for too long)
          if (member.status === 'stopped' && member.speed === 0) {
            const stoppedDuration = Date.now() - member.location.timestamp;
            if (stoppedDuration > 600000) { // 10 minutes
              io.to(`trip:${socket.tripId}`).emit('alert:member_stopped', {
                userId: socket.userId,
                name: member.name,
                duration: Math.floor(stoppedDuration / 60000),
              });
            }
          }
        }
      } catch (error) {
        console.error('Location update error:', error);
        socket.emit('error', { message: 'Failed to update location' });
      }
    });
    
    // Voice broadcast (leader only)
    socket.on('voice:broadcast', async (data) => {
      if (session.leader !== socket.userId) {
        return socket.emit('error', { message: 'Only the leader can broadcast voice messages' });
      }
      
      // Broadcast voice message to all members
      socket.to(`trip:${socket.tripId}`).emit('voice:message', {
        userId: socket.userId,
        name: socket.userName,
        message: data.message,
        duration: data.duration,
        timestamp: Date.now(),
      });
    });
    
    // Set trip leader
    socket.on('leader:set', (data) => {
      session.setLeader(data.userId);
      
      io.to(`trip:${socket.tripId}`).emit('leader:changed', {
        userId: data.userId,
        name: session.members.get(data.userId)?.name,
      });
    });
    
    // Start leading (Follow the Leader mode)
    socket.on('leader:start', () => {
      session.setLeader(socket.userId);
      
      io.to(`trip:${socket.tripId}`).emit('leader:started', {
        userId: socket.userId,
        name: socket.userName,
        message: `${socket.userName} is now leading the group`,
      });
    });
    
    // Request to follow leader
    socket.on('follow:request', () => {
      if (!session.leader) {
        return socket.emit('error', { message: 'No leader to follow' });
      }
      
      const leaderBreadcrumbs = session.getBreadcrumbs(session.leader);
      
      socket.emit('follow:breadcrumbs', {
        leaderId: session.leader,
        breadcrumbs: leaderBreadcrumbs,
      });
    });
    
    // Set destination
    socket.on('destination:set', (destination) => {
      session.destination = destination;
      
      io.to(`trip:${socket.tripId}`).emit('destination:updated', destination);
    });
    
    // Send message/alert
    socket.on('message:send', (data) => {
      io.to(`trip:${socket.tripId}`).emit('message:received', {
        userId: socket.userId,
        name: socket.userName,
        message: data.message,
        type: data.type || 'text',
        timestamp: Date.now(),
      });
    });
    
    // Emergency SOS
    socket.on('sos:send', () => {
      io.to(`trip:${socket.tripId}`).emit('sos:alert', {
        userId: socket.userId,
        name: socket.userName,
        location: session.members.get(socket.userId)?.location,
        timestamp: Date.now(),
      });
      
      // Could also trigger external notifications here
      console.log(`🆘 SOS Alert from ${socket.userName} in trip ${socket.tripId}`);
    });
    
    // Meeting point suggestion
    socket.on('meeting:suggest', (data) => {
      io.to(`trip:${socket.tripId}`).emit('meeting:point', {
        suggestedBy: socket.userId,
        name: socket.userName,
        location: data.location,
        placeName: data.placeName,
        timestamp: Date.now(),
      });
    });
    
    // Get trip statistics
    socket.on('stats:request', () => {
      socket.emit('stats:update', session.getMemberStats());
    });
    
  } catch (error) {
    console.error('Socket connection error:', error);
    socket.emit('error', { message: 'Connection setup failed' });
  }
  
  // Disconnect handling
  socket.on('disconnect', () => {
    console.log(`User ${socket.userId} disconnected from trip ${socket.tripId}`);
    
    try {
      // Don't immediately remove - mark as offline
      const member = session?.members.get(socket.userId);
      if (member) {
        member.status = 'offline';
        member.lastSeen = Date.now();
        
        // Notify others
        socket.to(`trip:${socket.tripId}`).emit('member:offline', {
          userId: socket.userId,
          name: socket.userName,
        });
        
        // Remove after timeout (5 minutes)
        setTimeout(() => {
          if (session?.members.get(socket.userId)?.status === 'offline') {
            session.removeMember(socket.userId);
            
            io.to(`trip:${socket.tripId}`).emit('member:left', {
              userId: socket.userId,
              name: socket.userName,
            });
            
            // Clean up empty sessions
            if (session.members.size === 0) {
              tripSessions.delete(socket.tripId);
              console.log(`Cleaned up empty session: ${socket.tripId}`);
            }
          }
        }, 300000); // 5 minutes
      }
    } catch (error) {
      console.error('Disconnect handling error:', error);
    }
  });
});

// Clean up stale sessions periodically
setInterval(() => {
  const now = Date.now();
  const staleTimeout = 3600000; // 1 hour
  
  for (const [tripId, session] of tripSessions) {
    if (now - session.lastUpdate > staleTimeout && session.members.size === 0) {
      tripSessions.delete(tripId);
      console.log(`Cleaned up stale session: ${tripId}`);
    }
  }
}, 300000); // Every 5 minutes

// Error handling
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start server
const PORT = process.env.PORT || 8080;
httpServer.listen(PORT, () => {
  console.log(`🚀 TripUs AI WebSocket server running on port ${PORT}`);
  console.log(`📡 Health check: /health`);
  console.log(`🔌 WebSocket: /socket.io/`);
});