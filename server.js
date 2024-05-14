const express = require('express');
const app = express();
const path = require('path');
const ws = require('ws');
const port = 3000;

// expects the default file to serve to be called index.html. if named otherwise, you'll get cannot GET
// https://stackoverflow.com/questions/44524424/get-http-localhost3000-404-not-found
app.use("/", express.static((path.join(__dirname, ""))));

app.listen(port, () => console.log("listening on port: " + port));

// websocket server
console.log('starting websocket server on port 8080...');
const wss = new ws.WebSocketServer({
  port: 8080,
  perMessageDeflate: {
    zlibDeflateOptions: {
      // See zlib defaults.
      chunkSize: 1024,
      memLevel: 7,
      level: 3
    },
    zlibInflateOptions: {
      chunkSize: 10 * 1024
    },
    // Other options settable:
    clientNoContextTakeover: true, // Defaults to negotiated value.
    serverNoContextTakeover: true, // Defaults to negotiated value.
    serverMaxWindowBits: 10, // Defaults to negotiated value.
    // Below options specified as default values.
    concurrencyLimit: 10, // Limits zlib concurrency for perf.
    threshold: 1024 // Size (in bytes) below which messages
    // should not be compressed if context takeover is disabled.
  }
});

function getRandomInRange(min, max){
  return Math.floor(Math.random() * (max - min) + min);
}

// https://stackoverflow.com/questions/13364243/websocketserver-node-js-how-to-differentiate-clients
function getUniqueId(){
  // TODO: uuid instead?
  return Date.now();
}

const currGameState = {
  'players': {}, // keep track of player positions
  'objects': {},
  'projectiles': {},
};

function setupMapObjects(gameState){
  const box = {
    'type': 'box',
    'name': 'box',
    'x': -10,
    'y': 0.868,
    'z': -20,
  };
  
  const box2 = {
    'type': 'box',
    'name': 'box2',
    'x': -10,
    'y': 2.818,
    'z': -20,
  };
  
  const target = {
    'type': 'target',
    'name': 'target',
    'x': 10,
    'y': 1.469,
    'z': -30,
  };
  
  const barrel = {
    'type': 'barrel',
    'name': 'barrel',
    'x': 1.1,
    'y': 1.388,
    'z': 5,
  };
  
  gameState.objects['box'] = box;
  gameState.objects['box2'] = box2;
  gameState.objects['target'] = target;
  gameState.objects['barrel'] = barrel;
}

function resetGameState(gameState){
  gameState.players = {};
  gameState.objects = {};
  gameState.projectiles = {};
  setupMapObjects(gameState);
}

setupMapObjects(currGameState);

wss.on('connection', (conn) => {
  // assign an id to this connection
  conn.id = getUniqueId();
  
  conn.on('error', console.error);

  conn.on('open', () => conn.send('hello!'));

  conn.on('message', (data) => {
    try {
      //console.log(`received: ${data}`);
      const parsedData = JSON.parse(data);
      const key = parsedData.key;
      
      if(key === 'hello'){
        // got a new player
        // send initial position of player
        console.log('sending initial pos for player...');
        const xPos = getRandomInRange(-20, 20);
        const zPos = getRandomInRange(-20, 20);
        
        conn.send(
          JSON.stringify({
            id: conn.id,
            key: 'initialPos',
            x: xPos,
            y: 1.4,
            z: zPos,
          })
        );
        
        // also send message about current game state
        conn.send(
          JSON.stringify({
            id: conn.id,
            key: 'updateGameState',
            state: currGameState,
          })
        );      
        
        // add new player to curr game state
        // TODO: what about rotation?
        currGameState.players[conn.id] = {
          x: xPos,
          y: 1.4,
          z: zPos,
        };
        
        // send this info to everyone else as well
        wss.clients.forEach(client => {
          if(client.id !== conn.id){
            //console.log(client);
            client.send(JSON.stringify({
              id: conn.id,
              key: 'newPlayer',
              x: xPos,
              y: 1.4,
              z: zPos,
            }));
          }
        });
      }else if(key === 'updatePlayerState'){
        // got an update about player state
        const playerId = parsedData.id;
        currGameState.players[playerId].position = parsedData.position;
        currGameState.players[playerId].quaternion = parsedData.quaternion;
        currGameState.players[playerId].action = parsedData.action;
        
        // broadcast update to clients
        wss.clients.forEach(client => {
          if(client.id !== conn.id){
            client.send(JSON.stringify({
              id: conn.id,
              key: 'updateGameState',
              state: currGameState,
            }));
          }
        });
      }else if(key === 'updateObjectState'){
        const objId = parsedData.id; // object name, should be unique 
        currGameState.objects[objId].position = parsedData.position;
        currGameState.objects[objId].quaternion = parsedData.quaternion;
        
        // broadcast update to clients
        wss.clients.forEach(client => {
          if(client.id !== conn.id){
            client.send(JSON.stringify({
              id: conn.id,
              key: 'updateGameState',
              state: currGameState,
            }));
          }
        });
      }else if(key === 'updateProjectileState'){
        const objId = parsedData.id; // object name, should be unique 
        currGameState.projectiles[objId].position = parsedData.position;
        currGameState.projectiles[objId].quaternion = parsedData.quaternion;
        
        // broadcast update to clients
        wss.clients.forEach(client => {
          if(client.id !== conn.id){
            client.send(JSON.stringify({
              id: conn.id,
              key: 'updateGameState',
              state: currGameState,
            }));
          }
        });
      }else if(key === 'addProjectile'){
        const objId = parsedData.id;
        currGameState.projectiles[objId] = {
          name: objId,
          position: parsedData.position,
          quaternion: parsedData.quaternion,
        };
        
        // broadcast update to clients
        wss.clients.forEach(client => {
          if(client.id !== conn.id){
            client.send(JSON.stringify({
              id: conn.id,
              key: 'updateGameState',
              state: currGameState,
            }));
          }
        });
      }else if(key === 'removeProjectile'){
        const objId = parsedData.id;
        
        delete currGameState.projectiles[objId];
        
        // broadcast update to clients
        wss.clients.forEach(client => {
          if(client.id !== conn.id){
            client.send(JSON.stringify({
              id: objId,
              key: 'removeProjectile',
            }));
          }
        });
      }
    }catch(error){
      console.log(`received unparsable message: ${error}`);
    }
  });
  
  conn.on('close', () => {
    console.log(`closed connection: ${conn.id}`);
    
    delete currGameState.players[conn.id];
    
    // tell everyone who's still on that this player has left
    wss.clients.forEach(client => {
        if(client.id !== conn.id){
          client.send(JSON.stringify({
            id: conn.id,
            key: 'playerLeft',
          }));
        }
      });
  });
});