import { AnimationController } from './AnimationController.js';
import { SkeletonUtils } from "https://cdn.skypack.dev/three@0.129.0/examples/jsm/utils/SkeletonUtils.js";

const container = document.getElementById("container");
const fov = 60;
const defaultCamera = new THREE.PerspectiveCamera(fov, container.clientWidth / container.clientHeight, 0.01, 1000);
const keyboard = new THREEx.KeyboardState();
const raycaster = new THREE.Raycaster();

const loader = new THREE.GLTFLoader();

const renderer = new THREE.WebGLRenderer({antialias: true});
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setSize(container.clientWidth, container.clientHeight); 
renderer.domElement.id = "theCanvas";  
container.appendChild(renderer.domElement);

// overlay canvas for displaying crosshairs
const crosshairCanvas = document.createElement('canvas');
crosshairCanvas.style.position = 'absolute';
crosshairCanvas.style.left = '0';
crosshairCanvas.style.top = '0';
crosshairCanvas.style.border = '1px solid #000';
crosshairCanvas.style.width = renderer.domElement.width + 'px';
crosshairCanvas.style.height = renderer.domElement.height + 'px';
crosshairCanvas.style.display = 'none';
crosshairCanvas.width = renderer.domElement.width;
crosshairCanvas.height = renderer.domElement.height;

// make background color transparent
const ctx = crosshairCanvas.getContext('2d');
ctx.fillStyle = 'rgba(255, 255, 255, 0)';
ctx.fillRect(0, 0, crosshairCanvas.width, crosshairCanvas.height);

// TODO: put crosshair image on canvas
const crosshairImg = new Image();
crosshairImg.onload = () => {
  ctx.drawImage(crosshairImg, 200, 130);
};
crosshairImg.src = "crosshairs.png";

container.appendChild(crosshairCanvas);

const camera = defaultCamera;
camera.position.set(0, 5, 20);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xffffff);    
scene.add(camera);

const light = new THREE.PointLight(0xffffff, 1.2, 100);
light.position.set(0, 70, 0);
light.castShadow = true;
scene.add(light);

const hemiLight = new THREE.HemisphereLight(0xffffff);
hemiLight.position.set(0, 50, 0);
scene.add(hemiLight);

const clock = new THREE.Clock();
let sec = clock.getDelta();
let moveDistance = 60 * sec;
let rotationAngle = (Math.PI / 2) * sec;

let animationController;
let animationMixer = null;
let animationClips = null;

let wsserver = null;
let player = null;
let tool = null;
let terrain = null;
let firstPersonViewOn = false;
let sideViewOn = false;
//let playerBody;

// typescript would be soooo helpful here ;)
const localGameState = {
  'id': '',
  'player': {},
  'projectiles': {},
  'objects': {},
  'npcs': {},
};

const mouseX = 0;
const mouseY = 0;

let cowProjectileMesh;

const cannonBodies = [];
const projectiles = new Set();

const world = new CANNON.World();
world.gravity.set(0, -9.82, 0);

const cannonDebugRenderer = new THREE.CannonDebugRenderer(scene, world);

// add ground
function addGround(scene, world){
  const texture = new THREE.TextureLoader().load('grass2.jpg');
  const terrainMat = new THREE.MeshPhongMaterial({map: texture, side: THREE.DoubleSide});
  const terrainGeometry = new THREE.PlaneGeometry(200, 200);
  const plane = new THREE.Mesh(terrainGeometry, terrainMat);
  plane.receiveShadow = true;
  plane.castShadow = false;
  plane.rotateX(Math.PI / 2);
  plane.name = "ground";
  plane.translateY(0.6);
  scene.add(plane);
  
  const planeShape = new CANNON.Plane();
  const groundMat = new CANNON.Material();
  const planeBody = new CANNON.Body({material: groundMat, mass: 0}); // this plane extends infinitely
  planeBody.addShape(planeShape);
  planeBody.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI/2);
  planeBody.mesh = plane;
  world.addBody(planeBody);
  
  return plane;
}

function addCannonBox(mesh, width, height, length, x, y, z, mass=0, boxName=''){
  const box = new CANNON.Box(new CANNON.Vec3(width, height, length));
  const mat = new CANNON.Material();
  const body = new CANNON.Body({material: mat, mass});
    
  body.position.x = x;
  body.position.y = y;
  body.position.z = z;
    
  body.addShape(box);
  world.addBody(body);
    
  body.mesh = mesh; // associate mesh with body (not sure there's an official way of doing this atm but it works at least?
  
  body.name = boxName;
    
  // detect collision
  // https://stackoverflow.com/questions/31750026/cannon-js-registering-collision-without-colliding
  body.addEventListener("collide", (e) => {
    const collidingObj = e.body.mesh;
    
    // ignore player's own collision box so projectiles can pass through
    if(body.name.includes(player.name)){
      return;
    }
    
    if(collidingObj.name && collidingObj.name.includes("projectile")){
      const hitTarget = e.target.mesh;
      
      if(body.mesh.type !== 'SkinnedMesh'){
        // if the object hit by the projectile is NOT a skinnedmesh (e.g. not a NPC)
        const hitMaterial = new THREE.MeshBasicMaterial({color: 0xff0000});
        hitTarget.material = hitMaterial;
      }else{
        // otherwise just change the color of the existing material to red
        body.mesh.material.color.g = 0;
        body.mesh.material.color.b = 0;
        body.mesh.material.emissive.r = 1;
      }

      setTimeout(() => {
        if(body.mesh.type !== 'SkinnedMesh'){
          hitTarget.material = hitTarget.originalColor;
        }else{
          body.mesh.material.color.g = 1;
          body.mesh.material.color.b = 1;
          body.mesh.material.emissive.r = 0;
        }
      }, 300);
      
      // send message to server that this object has been hit
      // projectile can be removed from curr game state
      // TODO: maybe only care about certain collisions, e.g. box-projectile, not projectile-projectile?
      sendObjectUpdate({
        id: mesh.name,
        position: body.position,
        quaternion: body.quaternion,
      });
      
      //console.log(body);
    }
  });
    
  return {planeBody: body, mat};
}

function generateProjectile(x, y, z){
  const useCowProjectile = false; //document.getElementById('useCowProjectile').checked;
  if(!useCowProjectile){
    const sphereGeometry = new THREE.SphereGeometry(0.05, 32, 16);
    const normalMaterial = new THREE.MeshPhongMaterial({color: 0x055C9D});
    const sphereMesh = new THREE.Mesh(sphereGeometry, normalMaterial);
    sphereMesh.receiveShadow = true;
    sphereMesh.castShadow = true;
    sphereMesh.position.set(x, y, z);
    sphereMesh.name = "projectile";
    scene.add(sphereMesh);

    const sphereShape = new CANNON.Sphere(0.05);
    const sphereMat = new CANNON.Material();
    const sphereBody = new CANNON.Body({material: sphereMat, mass: 0.2});
    sphereBody.addShape(sphereShape);
    sphereBody.position.x = sphereMesh.position.x;
    sphereBody.position.y = sphereMesh.position.y;
    sphereBody.position.z = sphereMesh.position.z;
    sphereBody.mesh = sphereMesh;
    world.addBody(sphereBody);
        
    return {sphereMesh, sphereBody};
  }else{
    const cowMesh = cowProjectileMesh.clone();
    cowMesh.receiveShadow = true;
    cowMesh.castShadow = true;
    cowMesh.position.set(x, y, z);
    cowMesh.name = "projectile";
    scene.add(cowMesh);
        
    const sphereShape = new CANNON.Sphere(1.2);
    const sphereMat = new CANNON.Material();
    const sphereBody = new CANNON.Body({material: sphereMat, mass: 0.2});
    sphereBody.addShape(sphereShape);
    sphereBody.position.x = cowMesh.position.x;
    sphereBody.position.y = cowMesh.position.y;
    sphereBody.position.z = cowMesh.position.z;
    sphereBody.mesh = cowMesh;
    world.addBody(sphereBody);

    return {sphereMesh: cowMesh, sphereBody};        
  }
}

function getModel(modelFilePath, name){
  return new Promise((resolve, reject) => {
    loader.load(
      modelFilePath,
      function(gltf){
        if(gltf.animations.length > 0 && name === "player"){
          const clips = {};
          gltf.animations.forEach((action) => {
            let name = action['name'].toLowerCase();
            name = name.substring(0, name.length - 1);
            clips[name] = action;
          });
          animationClips = clips;
        }
                
        // if a scene has multiple meshes you want (like for the m4 carbine),
        // do the traversal and attach the magazine mesh as a child or something to the m4 mesh.
        // then resolve the thing outside the traverse.
        const carbine = [];
        gltf.scene.traverse((child) => {
          if(child.type === "Mesh" || child.type === "SkinnedMesh"){
            const obj = child;

            if(name === "obj"){
              obj.scale.x = child.scale.x * 1.1;
              obj.scale.y = child.scale.y * 1.1;
              obj.scale.z = child.scale.z * 1.1;
              carbine.push(obj);
            }else{
              if(child.type === "SkinnedMesh"){
                if(name !== "obj"){
                  obj.scale.x *= .3;
                  obj.scale.y *= .3;
                  obj.scale.z *= .3;
                }
                
                obj.add(obj.skeleton.bones[0]); // add pelvis to mesh as a child
              }
                            
              if(name === "bg"){
                obj.scale.x = child.scale.x * 10;
                obj.scale.y = child.scale.y * 10;
                obj.scale.z = child.scale.z * 10;
              }
                            
              obj.name = name;
              
              resolve(obj); // this will return only one mesh. if you expect a scene to yield multiple meshes, this will fail.
            }
          }
        });
                
        // for the carbine (or really any scene with multiple meshes)
        if(name === "obj"){
          const m4carbine = carbine[0];
          m4carbine.add(m4carbine.skeleton.bones[0]);
          m4carbine.name = name;
                    
          const magazine = carbine[1];
          m4carbine.magazine = magazine;
          m4carbine.skeleton.bones[1].add(magazine); // add magazine to the mag bone

          m4carbine.rotateOnAxis(new THREE.Vector3(0,1,0), Math.PI/2);
          m4carbine.rotateOnAxis(new THREE.Vector3(0,0,-1), Math.PI/2);

          resolve(m4carbine);
        }
      },
      // called while loading is progressing
      function(xhr){
        console.log( (xhr.loaded / xhr.total * 100) + '% loaded' );
      },
      // called when loading has errors
      function(error){
        console.log('An error happened');
        console.log(error);
      }
    );
  });
}

getModel('cow.gltf', 'cow').then(model => {
  cowProjectileMesh = model;
  modelTemplates.cow = model;
});

const modelTemplates = {
  'player': null,
  'box': null,
  'cow': null,
  'target': null,
  'barrel': null,
};

function instantiatePlayer(xPos, yPos, zPos, id){
  if(modelTemplates.player){
    // https://discourse.threejs.org/t/skinnedmesh-cloning-issues/27551/4
    const mesh = SkeletonUtils.clone(modelTemplates.player);
    mesh.material = modelTemplates.player.material.clone();
    mesh.originalColor = mesh.material;
    
    mesh.name = id;
    
    // some bones like ik ones that come from the armature, which turns out to be the 
    // parent of the player model, become undefined in the clone mesh's skeleton bones array :/
    mesh.skeleton.bones = mesh.skeleton.bones.filter(x => x !== undefined);
    
    // need to add armature (e.g. ik bones) manually. seems kinda weird but at least this works :)
    modelTemplates.player.parent.clone().children.forEach(c => {
      if(c.type === 'Bone'){
        mesh.skeleton.bones.push(c);
      }
    });
    
    mesh.castShadow = true;
    player = mesh;

    // add a 3d object (cube) to serve as a marker for the 
    // location of the head of the mesh. we'll use this to 
    // create a vertical ray towards the ground
    // this ray can tell us the current height.
    // if the height is < the height of our character,
    // we know that we're on an uphill part of the terrain 
    // and can adjust our character accordingly
    // similarly, if the height is > the character height, we're going downhill
    const cubeGeometry = new THREE.BoxGeometry(0.2, 0.2, 0.2);
    const material = new THREE.MeshBasicMaterial({color: 0x00ff00});
    const head = new THREE.Mesh(cubeGeometry, material);
    head.visible = false;
    
    mesh.add(head);
    mesh.head = head;
    head.position.set(0, 4, 0);
          
    animationMixer = new THREE.AnimationMixer(mesh);
    animationController = new AnimationController(player, animationMixer, animationClips, clock);
    animationController.changeState("normal"); // set normal state by default for animations. see animation_state_map.json

    mesh.position.set(xPos, yPos, zPos);
    //mesh.position.set(getRandomInRange(-20, 20), 1.4, getRandomInRange(-20, 20));
    mesh.rotateOnAxis(new THREE.Vector3(0, 1, 0), Math.PI);
          
    // add hand bone to equip tool with as a child of the player mesh
    player.skeleton.bones.forEach(bone => {
      if(bone && bone.name === "HandR001"){
        player.hand = bone; // set an arbitrary new property to access the hand bone
      }
              
      if(bone && bone.name === "Chest"){
        player.chest = bone;
        player.head.quaternion.copy(bone.quaternion); // make sure head mesh follows chest bone rotation
      }
    });
    
    scene.add(mesh);
    
    return mesh;
  }
  
  return null;
}

function instantiateNPC(xPos, yPos, zPos, id){
  if(modelTemplates.player){
    // https://discourse.threejs.org/t/skinnedmesh-cloning-issues/27551/4
    const mesh = SkeletonUtils.clone(modelTemplates.player);
    mesh.material = modelTemplates.player.material.clone();
    mesh.originalColor = mesh.material;    
    mesh.name = id;
    
    // some bones like ik ones that come from the armature, which turns out to be the 
    // parent of the player model, become undefined in the clone mesh's skeleton bones array :/
    mesh.skeleton.bones = mesh.skeleton.bones.filter(x => x !== undefined);
    
    // need to add armature (e.g. ik bones) manually. seems kinda weird but at least this works :)
    modelTemplates.player.parent.clone().children.forEach(c => {
      if(c.type === 'Bone'){
        mesh.skeleton.bones.push(c);
      }
    });
    
    mesh.castShadow = true;

    // add a 3d object (cube) to serve as a marker for the 
    // location of the head of the mesh. we'll use this to 
    // create a vertical ray towards the ground
    // this ray can tell us the current height.
    // if the height is < the height of our character,
    // we know that we're on an uphill part of the terrain 
    // and can adjust our character accordingly
    // similarly, if the height is > the character height, we're going downhill
    const cubeGeometry = new THREE.BoxGeometry(0.2, 0.2, 0.2);
    const material = new THREE.MeshBasicMaterial({color: 0x00ff00});
    const head = new THREE.Mesh(cubeGeometry, material);
    head.visible = false;
          
    mesh.add(head);
    mesh.head = head;
    head.position.set(0, 4, 0);
    
    const animationController = new AnimationController(mesh, new THREE.AnimationMixer(mesh), animationClips, clock);
    animationController.changeState("normal"); // set normal state by default for animations. see animation_state_map.json

    mesh.position.set(xPos, yPos, zPos);
    //mesh.position.set(getRandomInRange(-20, 20), 1.4, getRandomInRange(-20, 20));
    mesh.rotateOnAxis(new THREE.Vector3(0, 1, 0), Math.PI);
          
    // add hand bone to equip tool with as a child of the npc mesh
    mesh.skeleton.bones.forEach(bone => {
      if(bone && bone.name === "HandR001"){
        mesh.hand = bone; // set an arbitrary new property to access the hand bone
      }
              
      if(bone && bone.name === "Chest"){
        mesh.chest = bone;
        mesh.head.quaternion.copy(bone.quaternion); // make sure head mesh follows chest bone rotation
      }
    });
    
    scene.add(mesh);
    
    return {mesh, animationController};
  }
  
  return null;
}

function instantiateBarrel(x, y, z, name){
  // remember: the mesh itself should be referenced by the cannon box
  // so we only need to keep track of the cannon box
  if(modelTemplates.barrel){
    const mesh = modelTemplates.barrel.clone();
    mesh.material = modelTemplates.barrel.material.clone();
    mesh.originalColor = mesh.material;
    mesh.name = name;
    
    mesh.position.set(x, y, z);
    //mesh.position.set(1.1, mesh.position.y, 5);
    const bbox = new THREE.Box3().setFromObject(mesh);
            
    const cannonBox = addCannonBox(
      mesh,
      Math.abs(bbox.max.x - bbox.min.x) / 2, 
      Math.abs(bbox.max.y - bbox.min.y) / 2, 
      Math.abs(bbox.max.z - bbox.min.z) / 2, 
      mesh.position.x, mesh.position.y - 0.3, mesh.position.z,
      30
    );
    
    cannonBodies.push(cannonBox);
    
    return {mesh, cannonBox};
  }
  
  return null;
}

function instantiateBox(x, y, z, name){
  // remember: the mesh itself should be referenced by the cannon box
  // so we only need to keep track of the cannon box
  if(modelTemplates.box){
    const mesh = modelTemplates.box.clone();
    mesh.material = modelTemplates.box.material.clone();
    mesh.originalColor = mesh.material;
    mesh.name = name;
    
    mesh.position.set(x, y, z);
            
    const bbox = new THREE.Box3().setFromObject(mesh);
            
    const cannonBox = addCannonBox(
      mesh,
      Math.abs(bbox.max.x - bbox.min.x) / 2, 
      Math.abs(bbox.max.y - bbox.min.y) / 2, 
      Math.abs(bbox.max.z - bbox.min.z) / 2, 
      mesh.position.x, mesh.position.y, mesh.position.z,
      5
    );
    
    cannonBodies.push(cannonBox);

    return {mesh, cannonBox};
  }
  
  return null;
}

function instantiateTarget(x, y, z, name){
  // remember: the mesh itself should be referenced by the cannon box
  // so we only need to keep track of the cannon box
  if(modelTemplates.target){
    const mesh = modelTemplates.target.clone();
    mesh.material = modelTemplates.target.material.clone();
    mesh.originalColor = mesh.material;
    mesh.name = name;
    
    mesh.position.set(x, y, z);
    mesh.scale.x *= 4;
    mesh.scale.y *= 4;
    mesh.scale.z *= 4;
    mesh.rotateX(Math.PI / 8);
    mesh.rotateY(-Math.PI / 1.5);
    mesh.rotateX(-Math.PI / 10);
            
    const bbox = new THREE.Box3().setFromObject(mesh);
            
    const body = addCannonBox(
      mesh,
      Math.abs(bbox.max.x - bbox.min.x) / 3.8, 
      Math.abs(bbox.max.y - bbox.min.y) / 2.5, 
      Math.abs(bbox.max.z - bbox.min.z) / 5, 
      mesh.position.x + 0.5, mesh.position.y, mesh.position.z,
    );
            
    body.planeBody.quaternion.setFromAxisAngle(
      new CANNON.Vec3(0, 1, 0),
      -Math.PI / 6
    );

    cannonBodies.push(body);
    
    return {mesh, cannonBox: body};
  }
  
  return null;
}

function initializeGame(){
  terrain = addGround(scene, world);
  
  const loadedModels = [
    getModel('humanoid-rig-with-gun.gltf', 'player'),
    getModel('m4carbine-final.gltf', 'obj'),
    getModel('target.gltf', 'target'),
    getModel('box.gltf', 'box'),
    getModel('box.gltf', 'box2'),
    getModel('barrel.gltf', 'barrel'),
  ];
  
  Promise.all(loadedModels).then(objects => {
    objects.forEach(mesh => {
      if(mesh.name === "obj"){
        // tools that can be equipped
        mesh.castShadow = true;
        tool = mesh;
        tool.visible = false;
        scene.add(mesh);
      }else if(mesh.name === "target" || mesh.name.includes("box") || mesh.name === "barrel"){
        mesh.castShadow = true;
        if(mesh.name === "target"){
          modelTemplates.target = mesh;
        }
        
        if(mesh.name === "box"){
          modelTemplates.box = mesh;
        }
        
        if(mesh.name === "barrel"){
          modelTemplates.barrel = mesh;
        }
      }else if(mesh.name === "player"){
        modelTemplates.player = mesh;
        
        // connect to websocket server and instantiate our player
        wsserver = new WSClient('ws://localhost:8080', localGameState);
      }
      
      renderer.render(scene, camera);
    });
  });  
}
initializeGame();

function moveBasedOnAction(controller, player, speed, reverse){
  const action = controller.currAction;
  if(action === 'walk' || action === 'run'){
    if(action === 'run'){
      speed += 0.10;
    }
    if(reverse){
      player.translateZ(-speed);
    }else{
      player.translateZ(speed);
    }
    
    // send update to wss about player position and rotation
    sendPlayerUpdate(player);
    
    // also update collision box
    player.collisionBox.planeBody.position.copy(player.position);
    player.collisionBox.planeBody.quaternion.copy(player.quaternion);
  }
}

function checkCollision(moveDistance, isReverse){
  for(const body of cannonBodies){
    const bodyPos = body.planeBody.position;
    const destPos = new THREE.Vector3();
        
    // get forward vector of player
    player.getWorldDirection(destPos);
    destPos.multiplyScalar((isReverse ? -moveDistance : moveDistance));
        
    // using player.position doesn't seem to work - I guess cause it's local instead of world?
    const playerWorldPos = new THREE.Vector3();
    player.getWorldPosition(playerWorldPos);
    destPos.add(playerWorldPos);
        
    if(destPos.distanceTo(bodyPos) < 2){
      return true;
    }
  }
  return false;
}

function keydown(evt){
  if(evt.keyCode === 16){
    // shift key
    // toggle between walk and run while moving
    if(animationController.currAction === 'walk'){
      animationController.changeAction('run');
      //animationController.setUpdateTimeDivisor(.12);
    }
  }else if(evt.keyCode === 71){
    // g key
    // for toggling weapon/tool equip
    const handBone = player.hand;
    if(handBone.children.length === 0){
      handBone.add(tool);
      // also register the tool in the animationcontroller so we can hide it at the 
      // right time when de-equipping
      // yeah, doing it this way is still kinda weird. :/
      animationController.addObject(tool);
    }
        
    // adjust location of tool 
    tool.position.set(0, 0.2, -0.3); // the coordinate system is a bit out of whack for the weapon...
        
    // the weapon-draw/hide animation should lead directly to the corresponding idle animation
    // since I have the event listener for a 'finished' action set up
    let timeScale = 1.0;
        
    if(animationController.currState === "normal"){
      tool.visible = true;
      animationController.changeState("equip"); // equip weapon
    }else{
      animationController.changeState("normal");
      timeScale = -1; // need to play equip animation backwards to put away weapon
    }
    animationController.setUpdateTimeDivisor(0.002);
    animationController.changeAction("drawgun", timeScale);
    
    sendPlayerUpdate(player); // TODO: should send some info about whether the player has the weapon equipped or not
  }else if(evt.keyCode === 49){
    // toggle first-person view
    firstPersonViewOn = !firstPersonViewOn;
    sideViewOn = false;
        
    // make sure camera is in the head position
    // and that the camera is parented to the character mesh
    // so that it can rotate with the mesh
    if(firstPersonViewOn){
      player.add(camera);
      camera.position.copy(player.head.position);
      camera.position.z += 0.9;
      camera.position.y -= 0.4;
      camera.rotation.copy(player.chest.rotation);
      camera.rotateY(Math.PI);
    }else{
      scene.add(camera);
    }
  }else if(evt.keyCode === 50){
    // toggle side view
    firstPersonViewOn = false;
    sideViewOn = !sideViewOn;
  }
}

function keyup(evt){
  if(evt.keyCode === 16){
    if(animationController.currAction === 'run'){
      animationController.changeAction('walk');
      animationController.setUpdateTimeDivisor(.12);
    }
  }
}

document.addEventListener("keydown", keydown);
document.addEventListener("keyup", keyup);
document.getElementById("theCanvas").parentNode.addEventListener("pointerdown", (evt) => {
  if(animationController && animationController.currState !== "normal"){
    evt.preventDefault();
    const forwardVec = new THREE.Vector3();
    camera.getWorldDirection(forwardVec);
        
    const impulseVal = parseInt(document.getElementById('impulseSlider').value);
    forwardVec.multiplyScalar(impulseVal);
        
    const sphere = generateProjectile(player.position.x, player.position.y + 1.0, player.position.z);
    sphere.sphereBody.applyImpulse(new CANNON.Vec3(forwardVec.x, forwardVec.y, forwardVec.z), sphere.sphereBody.position);
    
    if(wsserver){
      sphere.name = `${localGameState.id}_projectile_${Date.now()}`;
      wsserver.sendMsg({
        id: sphere.name,
        key: 'addProjectile',
        position: sphere.sphereBody.position,
        quaternion: sphere.sphereBody.quaternion,
      });
      localGameState.projectiles[sphere.name] = sphere;
    }
    
    projectiles.add(sphere);
  }
});

// https://stackoverflow.com/questions/48131322/three-js-first-person-camera-rotation
document.getElementById("theCanvas").parentNode.addEventListener("mousemove", (evt) => {
  if(firstPersonViewOn){
    document.body.style.cursor = 'none';
    evt.preventDefault();
        
    const mouseMoveX = -(evt.clientX / renderer.domElement.clientWidth) * 2 + 1;
    const mouseMoveY = -(evt.clientY / renderer.domElement.clientHeight) * 2 + 1;
        
    player.chest.rotation.x = -mouseMoveY;
    player.chest.rotation.y = mouseMoveX;
        
    camera.position.copy(player.head.position);
    camera.position.z += 0.9;
    camera.position.y -= 0.4;
    camera.rotation.copy(player.chest.rotation);
    camera.rotateY(Math.PI);
  }
});

function update(){
  sec = clock.getDelta();
  moveDistance = 5 * sec;
  rotationAngle = (Math.PI / 2) * sec;
  let changeCameraView = false;
    
  if(keyboard.pressed("z")){
    changeCameraView = true;
  }
    
  if(player && keyboard.pressed("W")){
    // moving forwards
    if(animationController.currAction !== "run"){
      animationController.changeAction('walk');
    }
    animationController.setUpdateTimeDivisor(.008);
        
    if(!checkCollision(moveDistance, false)){
      moveBasedOnAction(animationController, player, moveDistance, false);
    }
  }else if(player && keyboard.pressed("S")){
    // moving backwards
    if(animationController.currAction !== "run"){
      animationController.changeAction('walk', -1);
    }
    animationController.setUpdateTimeDivisor(.008);
        
    if(!checkCollision(moveDistance, true)){
      moveBasedOnAction(animationController, player, moveDistance, true);
    }
        
    //playerBody.velocity.z = -0.5;
  }else if(player && !keyboard.pressed("W") && !keyboard.pressed("S")){
    // can we make this less specific i.e. don't explicitly check for "drawgun"?
    if(animationController.currAction !== 'idle' && animationController.currAction !== "drawgun"){
      animationController.changeAction('idle');
      animationController.setUpdateTimeDivisor(.01);
    }
  }
    
  if(player && keyboard.pressed("A")){
    player.rotateOnAxis(new THREE.Vector3(0, 1, 0), rotationAngle);
    sendPlayerUpdate(player);
  }
    
  if(player && keyboard.pressed("D")){
    player.rotateOnAxis(new THREE.Vector3(0, 1, 0), -rotationAngle);
    sendPlayerUpdate(player);
  }
    
  // we don't want idle animation to run if in first-person mode since I want to
  // manually control the chest bone for look-around rotation
  if(player && (animationController.currAction !== 'idle' || !firstPersonViewOn)){
    // keep the current animation running
    animationController.update();
  }
    
  let relCameraOffset;
    
  if(player){
    if(firstPersonViewOn){
      // have crosshairs showing
      crosshairCanvas.style.display = 'block';
          
      // https://stackoverflow.com/questions/25567369/show-children-of-invisible-parents
      // TODO: we need to make sure we only affect the player, not NPCs!
      player.material.visible = false;
    }else if(sideViewOn){
      relCameraOffset = new THREE.Vector3(-10, 3, 0);
    }else if(!changeCameraView){
      relCameraOffset = new THREE.Vector3(0, 3, -15);
    }else{
      relCameraOffset = new THREE.Vector3(0, 3, 15);
    }
  }
    
  if(player && !firstPersonViewOn){
    crosshairCanvas.style.display = 'none';
    document.body.style.cursor = 'default';
        
    player.material.visible = true;
        
    const cameraOffset = relCameraOffset.applyMatrix4(player.matrixWorld);
    camera.position.x = cameraOffset.x;
    camera.position.y = cameraOffset.y;
    camera.position.z = cameraOffset.z;
        
    camera.lookAt(player.position);
  }
  
  Object.keys(localGameState.npcs).forEach(npcId => {
    //localGameState.npcs[npcId].animCtrl.changeAction('idle'); // TODO: should be set to idle only once
    localGameState.npcs[npcId].animCtrl.update();
  });
}

function animate(){
  requestAnimationFrame(animate);
  renderer.render(scene, camera);
  update();
  cannonDebugRenderer.update();
    
  world.step(0.01);
    
  projectiles.forEach(p => {
    if(p.sphereMesh.position.y < 0.5){
      // remove projectile from scene and set of projectiles
      scene.remove(p.sphereMesh);
      world.remove(p.sphereBody);
      projectiles.delete(p);
      
      delete localGameState.projectiles[p.name];
      
      if(wsserver){
        wsserver.sendMsg({
          id: p.name,
          key: 'removeProjectile',
        });
      }
      
      return;
    }
    
    p.sphereMesh.position.set(
      p.sphereBody.position.x, 
      p.sphereBody.position.y, 
      p.sphereBody.position.z
    );
    
    p.sphereMesh.quaternion.set(
      p.sphereBody.quaternion.x,
      p.sphereBody.quaternion.y,
      p.sphereBody.quaternion.z,
      p.sphereBody.quaternion.w,
    );
    
    // send update to wss about position and rotation
    sendProjectileUpdate({
      id: p.name,
      position: p.sphereBody.position,
      quaternion: p.sphereBody.quaternion,
    });
  });
    
  cannonBodies.forEach(b => {
    const bBody = b.planeBody;
    const bMesh = bBody.mesh;
    
    // for now only have boxes be able to move on projectile impact
    if(bMesh.name.includes("box")){
      bMesh.position.set(
        bBody.position.x, 
        bBody.position.y, 
        bBody.position.z
      );
      
      bMesh.quaternion.set(
        bBody.quaternion.x,
        bBody.quaternion.y,
        bBody.quaternion.z,
        bBody.quaternion.w,
      );
      
      sendObjectUpdate({
        id: bMesh.name,
        position: bBody.position,
        quaternion: bBody.quaternion,
      });
    }
  });
}

document.getElementById('impulseSlider').addEventListener('change', (evt) => {
  document.getElementById('impulseVal').textContent = evt.target.value;
});

function removeNPC(scene, gameState, id){
  for(const c of scene.children){
    if(c.name === id){
      console.log(`removing player: ${c.name}`);
      scene.remove(c);
      delete gameState.npcs[id];
      break;
    }
  }
}

function addNPC(x, y, z, gameState, id){
  const {mesh: npc, animationController: animCtrl} = instantiateNPC(x, y, z, id);
  gameState.npcs[id] = {npc, animCtrl};
  
  // add cannonbox for projectile collisions
  npc.collisionBox = addCannonBox(npc, 0.5, 1.5, 0.5, x, y, z, 0, `${npc.name}_collision_box`);
  npc.collisionBox.planeBody.collisionResponse = 0;
  
  console.log(gameState);
}

function addPlayer(x, y, z, gameState, id){
  const playerMesh = instantiatePlayer(x, y, z, id);
  
  // add cannonbox for projectile collisions
  playerMesh.collisionBox = addCannonBox(playerMesh, 0.5, 1.5, 0.5, x, y, z, 0, `${playerMesh.name}_collision_box`);

  // make sure we don't actually do any collision response. we just want to detect.
  playerMesh.collisionBox.planeBody.collisionResponse = 0;
  
  gameState.id = id;
  gameState.player = playerMesh;
  console.log(gameState);
}

function sendPlayerUpdate(player){
  if(wsserver){
    wsserver.sendMsg({
      id: player.name,
      key: 'updatePlayerState',
      position: player.position,
      quaternion: player.rotation,
      action: animationController.currAction,
      /* bone rotation doesn't seem to accurately reflect
      // the animation state :/ but was worth a try I guess
      //
      // TODO: maybe better to just pass around the animation state,
      // e.g. 'walk' or 'run' and have the client take care of it
      // each mesh has its own corresponding animation controller anyway
      skeleton: player.skeleton.bones.map(b => {
        return {'name': b.name, 'rotation': b.rotation}
      }),
      // the less info we need to pass around, the better though
      // too much info in the websocket seems to slow things down, unsurprisingly
      */
    });
  }
}

function sendObjectUpdate(object){
  if(wsserver){
    wsserver.sendMsg({
      id: object.id,
      key: 'updateObjectState',
      position: object.position,
      quaternion: object.quaternion,
    });
  }
}

function sendProjectileUpdate(object){
  if(wsserver){
    wsserver.sendMsg({
      id: object.id,
      key: 'updateProjectileState',
      position: object.position,
      quaternion: object.quaternion,
    });
  }
}

class WSClient {
  constructor(url, localGameState){
    try{
      this.server = new WebSocket(url);
      
      this.server.onmessage = (evt) => {
        const data = JSON.parse(evt.data);
        
        if(data.key === 'initialPos'){
          addPlayer(data.x, data.y, data.z, localGameState, data.id);
          animate(); // start game loop
        }else if(data.key === 'newPlayer'){
          // new player has joined the game
          console.log(`a new player has joined: ${data.id}`);
          addNPC(data.x, data.y, data.z, localGameState, data.id);
        }else if(data.key === 'updateGameState'){
          // handle update on game state
          const gameState = data.state;
          
          // update NPCs
          for(const playerId in gameState.players){
            const currPlayerState = gameState.players[playerId];
            const pos = currPlayerState.position;
            const quat = currPlayerState.quaternion; // NOTE: this is actually THREE.js rotation btw
            const action = currPlayerState.action;
            
            if(localGameState.npcs[playerId]){
              if(pos && quat){
                localGameState.npcs[playerId].npc.position.copy(pos);
                localGameState.npcs[playerId].npc.rotation.copy(quat);
                
                // update npc collision box also
                localGameState.npcs[playerId].npc.collisionBox.planeBody.position.copy(pos);
                
                // TODO: having trouble serializing THREE.js quaternion - the cannon.js quaternion works though
                // should come up with a better idea, since the cannonjs body only has quaternion
                //localGameState.npcs[playerId].npc.collisionBox.planeBody.quaternion.copy(quat);
              }
              
              // TODO: run animation based on walking or running also?
              if(action !== localGameState.npcs[playerId].animCtrl.currAction){
                localGameState.npcs[playerId].animCtrl.setUpdateTimeDivisor(.008);
                localGameState.npcs[playerId].animCtrl.changeAction(action);
              }
            }else if(playerId != localGameState.id){
              // there's an npc we need to add
              console.log(`adding a new npc: ${playerId}`);
              
              // TODO: so this is a little silly but on initial player instantiation
              // we just give x, y and z coords but we should just make it a THREE.Vector3
              // for position so we can be consistent throughout.
              // and set a default quaternion too
              if(pos){
                addNPC(pos.x, pos.y, pos.z, localGameState, playerId);
              }else{
                addNPC(currPlayerState.x, currPlayerState.y, currPlayerState.z, localGameState, playerId);
              }
            }
          }
          
          // update any objects
          for(const obj in gameState.objects){
            if(localGameState.objects[obj]){
              // NOTE: we need to update the object's corresponding cannonBox
              const o = gameState.objects[obj];
              
              // initially objects get x, y, z positions
              // TODO: can we provide quaternion and position objects from the server initially?
              if(o.position && o.quaternion){
                localGameState.objects[obj].cannonBox.planeBody.position.copy(o.position);
                localGameState.objects[obj].cannonBox.planeBody.quaternion.copy(o.quaternion);
              }
            }else{
              // need to create new objects
              const newObj = gameState.objects[obj];
              const type = newObj.type;
              if(type === 'barrel'){
                const {mesh, cannonBox} = instantiateBarrel(newObj.x, newObj.y, newObj.z, newObj.name);
                scene.add(mesh); // TODO: can we handle this elsewhere
                localGameState.objects[newObj.name] = {mesh, cannonBox};
              }else if(type === 'box'){
                const {mesh, cannonBox} = instantiateBox(newObj.x, newObj.y, newObj.z, newObj.name);
                scene.add(mesh);
                localGameState.objects[newObj.name] = {mesh, cannonBox};
              }else if(type == 'target'){
                const {mesh, cannonBox} = instantiateTarget(newObj.x, newObj.y, newObj.z, newObj.name);
                scene.add(mesh);
                localGameState.objects[newObj.name] = {mesh, cannonBox};
              }
            }
          }
          
          // update projectiles
          for(const p in gameState.projectiles){
            const currP = gameState.projectiles[p];
            if(localGameState.projectiles[p]){
              if(currP.position && currP.quaternion){
                localGameState.projectiles[p].sphereBody.position.copy(currP.position);
                localGameState.projectiles[p].sphereBody.quaternion.copy(currP.quaternion);
              }
            }else{
              // need to create projectile      
              const newPrj = generateProjectile(0, 0, 0);
              newPrj.sphereBody.position.copy(currP.position);
              newPrj.sphereBody.quaternion.copy(currP.quaternion);
              localGameState.projectiles[p] = newPrj;
              projectiles.add(newPrj);
            }
          }
        }else if(data.key === 'removeProjectile'){
          const pId = data.id;
          console.log(`removing projectile: ${pId}`);
          delete localGameState.projectiles[pId];
        }else if(data.key === 'playerLeft'){
          // remove player specified by id from scene
          removeNPC(scene, localGameState, data.id);
        }
      };
    
      this.server.onopen = (evt) => {
        // say hi to the server :wave:
        this.sendMsg({'key': 'hello'});
      };
      
      this.server.onerror = (evt) => {
        console.log("WebSocket error: ", evt);
      };
      
      this.server.onclose = (evt) => {
        console.log('closed connection');
      };
    
    }catch(err){
      console.log(err);
    }
  }
  
  sendMsg = (msg) => {
    this.server.send(JSON.stringify(msg));
  }
}