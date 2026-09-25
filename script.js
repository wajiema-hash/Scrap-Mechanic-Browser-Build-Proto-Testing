import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
import RAPIER from 'https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.12.0/rapier.es.js';

await RAPIER.init();

const $ = (id) => document.getElementById(id);
const root = $('game-root');
const toolbar = $('toolbar');
const modePill = $('mode-pill');
const statusBar = $('status-bar');
const toastBox = $('toast');
const settingsPanel = $('settings-panel');
const sensitivityInput = $('sensitivity');
const gravityInput = $('gravity');
const snapInput = $('snap-mode');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fc6d9);
scene.fog = new THREE.Fog(0x9fc6d9, 35, 180);
const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.05, 300);
camera.rotation.order = 'YXZ';
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.outputColorSpace = THREE.SRGBColorSpace;
root.appendChild(renderer.domElement);

const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
const raycaster = new THREE.Raycaster();
const clock = new THREE.Clock();
const keys = new Set();
const blocks = [];
const wireGroup = new THREE.Group();
const ghostGroup = new THREE.Group();
scene.add(wireGroup, ghostGroup);

const PARTS = {
  block: { label: 'Block', color: 0x8ca4b7, size: [1, 1, 1], mass: 2 },
  wood: { label: 'Wood', color: 0xb77d46, size: [1, 1, 1], mass: 1.6 },
  metal: { label: 'Metal', color: 0x6c7e90, size: [1, 1, 1], mass: 2.2 },
  glass: { label: 'Glass', color: 0x5ed1ef, size: [1, 1, 1], mass: 1, transparent: true },
  seat: { label: 'Seat', color: 0xd65c4c, size: [0.9, 0.7, 0.9], mass: 1.2 },
  wheel: { label: 'Wheel', color: 0x252b33, size: [0.72, 0.72, 0.72], mass: 1.2, wheel: true },
  engine: { label: 'Engine', color: 0xffae43, size: [1.1, 0.9, 1.1], mass: 2.4, power: 8 },
  largeEngine: { label: 'Large Engine', color: 0xf27625, size: [1.5, 1, 1.5], mass: 3.2, power: 15 },
  motor: { label: 'Electric Motor', color: 0x59d48b, size: [1, 0.8, 1], mass: 2, power: 10 },
  battery: { label: 'Battery', color: 0x7467d2, size: [1, 1, 1], mass: 1.8, source: true },
  switch: { label: 'Switch', color: 0x35cba5, size: [0.7, 0.4, 0.7], mass: 0.7, source: true },
  and: { label: 'AND Gate', color: 0xc678e8, size: [0.9, 0.9, 0.9], mass: 1, gate: 'and' },
  or: { label: 'OR Gate', color: 0xed9b4d, size: [0.9, 0.9, 0.9], mass: 1, gate: 'or' },
  not: { label: 'NOT Gate', color: 0x55a6f2, size: [0.9, 0.9, 0.9], mass: 1, gate: 'not' },
  xor: { label: 'XOR Gate', color: 0xf05b9a, size: [0.9, 0.9, 0.9], mass: 1, gate: 'xor' },
};
const ORDER = ['block', 'wood', 'metal', 'glass', 'seat', 'wheel', 'engine', 'largeEngine', 'motor', 'battery', 'switch', 'and', 'or', 'not', 'xor'];

const state = {
  mode: 'build', selected: 'block', rotation: 0, snap: 1,
  yaw: 0, pitch: 0, sensitivity: Number(sensitivityInput.value), locked: false,
  driver: null, paused: false, lastWireUpdate: 0, ghost: null,
};

function toast(text) {
  toastBox.textContent = text;
  toastBox.classList.add('visible');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => toastBox.classList.remove('visible'), 1600);
}

function updateStatus() {
  modePill.textContent = `${state.mode.toUpperCase()} MODE${state.driver ? ' · DRIVING' : ''}`;
  statusBar.textContent = state.mode === 'build'
    ? `${PARTS[state.selected].label} · grid ${state.snap} · LMB place · RMB remove · R rotate`
    : state.driver ? 'W/S throttle · A/D steering · E exit seat' : 'WASD move · Space jump · E enter seat';
}

function addLights() {
  scene.add(new THREE.HemisphereLight(0xd9f1ff, 0x27333c, 1.5));
  const sun = new THREE.DirectionalLight(0xffe8b4, 2.2);
  sun.position.set(25, 35, 15);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  scene.add(sun);
}

function addGround() {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(140, 1, 140), new THREE.MeshStandardMaterial({ color: 0x4c6654, roughness: 0.9 }));
  mesh.position.y = -0.5;
  mesh.receiveShadow = true;
  scene.add(mesh);
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
  world.createCollider(RAPIER.ColliderDesc.cuboid(70, 0.5, 70), body);
}

function materialFor(type, ghost = false) {
  const p = PARTS[type];
  return new THREE.MeshStandardMaterial({
    color: p.color,
    roughness: 0.7,
    metalness: ['metal', 'engine', 'largeEngine', 'motor'].includes(type) ? 0.7 : 0.12,
    transparent: ghost || !!p.transparent,
    opacity: ghost ? 0.28 : p.transparent ? 0.52 : 1,
    depthWrite: !ghost,
  });
}

function geometryFor(type) {
  const p = PARTS[type];
  return p.wheel ? new THREE.CylinderGeometry(0.36, 0.36, 0.2, 24) : new THREE.BoxGeometry(...p.size);
}

function createMesh(type, ghost = false) {
  const mesh = new THREE.Mesh(geometryFor(type), materialFor(type, ghost));
  mesh.castShadow = !ghost;
  mesh.receiveShadow = !ghost;
  if (PARTS[type].wheel) mesh.rotation.z = Math.PI / 2;
  return mesh;
}

function createBody(mesh, type) {
  const p = PARTS[type];
  const desc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(mesh.position.x, mesh.position.y, mesh.position.z)
    .setLinearDamping(0.42)
    .setAngularDamping(0.7);
  const body = world.createRigidBody(desc);
  const collider = p.wheel
    ? RAPIER.ColliderDesc.cylinder(0.1, 0.36)
    : RAPIER.ColliderDesc.cuboid(p.size[0] / 2, p.size[1] / 2, p.size[2] / 2);
  collider.setFriction(p.wheel ? 1.5 : 0.85);
  world.createCollider(collider, body);
  return body;
}

function positionKey(v) {
  return `${Math.round(v.x / state.snap)}:${Math.round(v.y / state.snap)}:${Math.round(v.z / state.snap)}`;
}

function addPart(type, position, rotation = 0) {
  if (!PARTS[type]) return null;
  const mesh = createMesh(type);
  mesh.position.copy(position);
  mesh.rotation.y = rotation;
  const part = { id: crypto.randomUUID(), type, mesh, body: null, rotation, signal: 0, key: positionKey(position) };
  part.body = createBody(mesh, type);
  mesh.userData.part = part;
  blocks.push(part);
  scene.add(mesh);
  return part;
}

function removePart(part) {
  if (!part) return;
  scene.remove(part.mesh);
  world.removeRigidBody(part.body);
  const index = blocks.indexOf(part);
  if (index >= 0) blocks.splice(index, 1);
}

function buildToolbar() {
  toolbar.innerHTML = '';
  ORDER.forEach((type, index) => {
    const button = document.createElement('button');
    button.className = 'part-slot';
    const p = PARTS[type];
    button.innerHTML = `<span class="part-color" style="background:#${p.color.toString(16).padStart(6, '0')}"></span><span>${index + 1}. ${p.label}</span>`;
    button.onclick = () => selectPart(type, index);
    toolbar.appendChild(button);
  });
  selectPart('block', 0);
}

function selectPart(type, index = ORDER.indexOf(type)) {
  state.selected = type;
  document.querySelectorAll('.part-slot').forEach((button, i) => button.classList.toggle('active', i === index));
  updateStatus();
  updateGhost();
}

function getHit() {
  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
  return raycaster.intersectObjects(blocks.map((part) => part.mesh))[0] || null;
}

function placementPosition() {
  const hit = getHit();
  if (!hit) return null;
  const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
  const half = Math.max(...PARTS[state.selected].size) * 0.5;
  const point = hit.point.clone().add(normal.multiplyScalar(half + 0.03));
  const snap = state.snap;
  return new THREE.Vector3(
    Math.round(point.x / snap) * snap,
    Math.round(point.y / snap) * snap,
    Math.round(point.z / snap) * snap,
  );
}

function updateGhost() {
  ghostGroup.clear();
  state.ghost = null;
  if (state.mode !== 'build') return;
  const ghost = createMesh(state.selected, true);
  ghostGroup.add(ghost);
  state.ghost = ghost;
}

function updateGhostPosition() {
  if (!state.ghost || state.mode !== 'build') return;
  const pos = placementPosition();
  if (!pos) {
    state.ghost.visible = false;
    return;
  }
  state.ghost.visible = true;
  state.ghost.position.copy(pos);
  state.ghost.rotation.y = state.rotation;
  if (PARTS[state.selected].wheel) state.ghost.rotation.z = Math.PI / 2;
  state.ghost.material.color.set(blocks.some((part) => part.key === positionKey(pos)) ? 0xff5555 : PARTS[state.selected].color);
}

function placePart() {
  const pos = placementPosition();
  if (!pos || blocks.some((part) => part.key === positionKey(pos))) return;
  addPart(state.selected, pos, state.rotation);
  toast(`Placed ${PARTS[state.selected].label}`);
}

function removeTarget() {
  const hit = getHit();
  if (!hit) return;
  const part = blocks.find((item) => item.mesh === hit.object);
  if (part) {
    removePart(part);
    toast(`Removed ${PARTS[part.type].label}`);
  }
}

function switchMode() {
  state.mode = state.mode === 'build' ? 'play' : 'build';
  if (state.mode === 'build' && state.driver) exitSeat();
  updateGhost();
  updateStatus();
  toast(`${state.mode === 'build' ? 'Build' : 'Play'} mode`);
}

function nearestSeat() {
  const p = playerBody.translation();
  return blocks.filter((part) => part.type === 'seat').sort((a, b) => {
    const da = Math.hypot(a.mesh.position.x - p.x, a.mesh.position.z - p.z);
    const db = Math.hypot(b.mesh.position.x - p.x, b.mesh.position.z - p.z);
    return da - db;
  })[0];
}

function enterOrExitSeat() {
  if (state.driver) {
    exitSeat();
    return;
  }
  const seat = nearestSeat();
  if (!seat) return toast('No seat nearby');
  const player = playerBody.translation();
  if (Math.hypot(seat.mesh.position.x - player.x, seat.mesh.position.z - player.z) > 3.5) return toast('Seat is too far away');
  state.driver = seat;
  toast('Entered seat');
  updateStatus();
}

function exitSeat() {
  if (!state.driver) return;
  const p = state.driver.mesh.position.clone().add(new THREE.Vector3(0, 1.6, 2.4));
  playerBody.setTranslation({ x: p.x, y: p.y, z: p.z }, true);
  state.driver = null;
  toast('Exited seat');
  updateStatus();
}

function connectedVehicle() {
  if (!state.driver) return [];
  const rootPart = state.driver;
  const result = new Set([rootPart]);
  const queue = [rootPart];
  while (queue.length) {
    const current = queue.shift();
    for (const candidate of blocks) {
      if (result.has(candidate)) continue;
      if (current.mesh.position.distanceTo(candidate.mesh.position) <= 1.75) {
        result.add(candidate);
        queue.push(candidate);
      }
    }
  }
  return [...result];
}

function applySuspension(wheel, chassis, dt) {
  const delta = chassis.mesh.position.clone().sub(wheel.mesh.position);
  const distance = delta.length();
  if (!distance) return;
  const axis = delta.normalize();
  const target = 1.15;
  const compression = target - distance;
  const wheelVelocity = wheel.body.linvel();
  const chassisVelocity = chassis.body.linvel();
  const relativeSpeed = new THREE.Vector3(wheelVelocity.x - chassisVelocity.x, wheelVelocity.y - chassisVelocity.y, wheelVelocity.z - chassisVelocity.z).dot(axis);
  const force = THREE.MathUtils.clamp(compression * 18 - relativeSpeed * 3.2, -20, 20) * dt;
  const impulse = { x: axis.x * force, y: axis.y * force, z: axis.z * force };
  wheel.body.applyImpulse(impulse, true);
  chassis.body.applyImpulse({ x: -impulse.x, y: -impulse.y, z: -impulse.z }, true);
}

function vehicleStep(dt) {
  if (!state.driver) return;
  const vehicle = connectedVehicle();
  const wheels = vehicle.filter((part) => part.type === 'wheel');
  const motors = vehicle.filter((part) => ['engine', 'largeEngine', 'motor'].includes(part.type));
  const chassis = vehicle.find((part) => ['metal', 'wood', 'block', 'seat'].includes(part.type)) || state.driver;
  const throttle = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
  const steer = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
  const forward = new THREE.Vector3(Math.sin(state.yaw), 0, Math.cos(state.yaw));
  const power = motors.reduce((sum, motor) => sum + PARTS[motor.type].power, 0);
  const powered = vehicle.some((part) => part.type === 'battery' && part.signal > 0) || vehicle.some((part) => part.signal > 0);
  const driveImpulse = throttle * power * (powered || !vehicle.some((part) => ['battery', 'switch', 'and', 'or', 'not', 'xor'].includes(part.type)) ? 1 : 0) * dt * 0.12;

  for (const wheel of wheels) {
    applySuspension(wheel, chassis, dt);
    wheel.body.applyImpulse({ x: forward.x * driveImpulse, y: 0, z: forward.z * driveImpulse }, true);
    wheel.body.applyTorqueImpulse({ x: 0, y: steer * power * dt * 0.025, z: 0 }, true);
  }
  if (motors.length) chassis.body.applyImpulse({ x: forward.x * driveImpulse * 0.25, y: 0, z: forward.z * driveImpulse * 0.25 }, true);

  const p = state.driver.mesh.position;
  camera.position.lerp(new THREE.Vector3(p.x, p.y + 1.25, p.z + 0.7), 0.25);
  camera.rotation.set(state.pitch, state.yaw, 0, 'YXZ');
}

function playerStep() {
  if (state.driver) return;
  const input = new THREE.Vector3((keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0), 0, (keys.has('KeyS') ? 1 : 0) - (keys.has('KeyW') ? 1 : 0));
  if (input.lengthSq()) input.applyAxisAngle(new THREE.Vector3(0, 1, 0), state.yaw).normalize();
  const velocity = playerBody.linvel();
  playerBody.setLinvel({ x: input.x * 5.8, y: velocity.y, z: input.z * 5.8 }, true);
  if (keys.has('Space') && playerBody.translation().y < 1.8 && Math.abs(velocity.y) < 0.35) playerBody.applyImpulse({ x: 0, y: 6, z: 0 }, true);
  const p = playerBody.translation();
  camera.position.set(p.x, p.y + 1.2, p.z);
  camera.rotation.set(state.pitch, state.yaw, 0, 'YXZ');
}

function nearbyPowerNodes(part) {
  return blocks.filter((candidate) => candidate !== part && ['battery', 'switch', 'and', 'or', 'not', 'xor', 'engine', 'largeEngine', 'motor'].includes(candidate.type) && candidate.mesh.position.distanceTo(part.mesh.position) <= 3.2);
}

function evaluateLogic() {
  for (const part of blocks) part.signal = 0;
  const activeSwitch = keys.has('KeyL');
  for (const part of blocks) {
    if (part.type === 'battery') part.signal = 1;
    if (part.type === 'switch') part.signal = activeSwitch ? 1 : 0;
  }
  for (let pass = 0; pass < 3; pass++) {
    for (const gate of blocks.filter((part) => PARTS[part.type].gate)) {
      const inputs = nearbyPowerNodes(gate).map((part) => part.signal > 0);
      if (PARTS[gate.type].gate === 'and') gate.signal = inputs.length >= 2 && inputs.every(Boolean) ? 1 : 0;
      if (PARTS[gate.type].gate === 'or') gate.signal = inputs.some(Boolean) ? 1 : 0;
      if (PARTS[gate.type].gate === 'not') gate.signal = inputs.length > 0 && !inputs[0] ? 1 : 0;
      if (PARTS[gate.type].gate === 'xor') gate.signal = inputs.filter(Boolean).length === 1 ? 1 : 0;
    }
  }
  for (const output of blocks.filter((part) => ['engine', 'largeEngine', 'motor'].includes(part.type))) {
    output.signal = nearbyPowerNodes(output).some((part) => part.signal > 0) ? 1 : 0;
  }
}

function drawWires() {
  wireGroup.clear();
  const nodes = blocks.filter((part) => ['battery', 'switch', 'and', 'or', 'not', 'xor', 'engine', 'largeEngine', 'motor'].includes(part.type));
  const positions = [];
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    if (nodes[i].mesh.position.distanceTo(nodes[j].mesh.position) <= 3.2) positions.push(nodes[i].mesh.position, nodes[j].mesh.position);
  }
  if (!positions.length) return;
  const values = [];
  for (let i = 0; i < positions.length; i += 2) {
    values.push(positions[i].x, positions[i].y, positions[i].z, positions[i + 1].x, positions[i + 1].y, positions[i + 1].z);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(values, 3));
  wireGroup.add(new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0xffd45f, linewidth: 2 })));
}

function saveBuild() {
  const data = blocks.map((part) => ({ type: part.type, x: part.mesh.position.x, y: part.mesh.position.y, z: part.mesh.position.z, rotation: part.rotation }));
  localStorage.setItem('construct-lab-save-v3', JSON.stringify(data));
  toast('Build saved');
}

function loadBuild() {
  const raw = localStorage.getItem('construct-lab-save-v3');
  if (!raw) return toast('No save found');
  for (const part of [...blocks]) removePart(part);
  for (const item of JSON.parse(raw)) addPart(item.type, new THREE.Vector3(item.x, item.y, item.z), item.rotation || 0);
  toast('Build loaded');
}

function onKeyDown(event) {
  keys.add(event.code);
  if (event.code === 'Tab') { event.preventDefault(); switchMode(); }
  if (event.code === 'KeyE' && state.mode === 'play') enterOrExitSeat();
  if (event.code === 'KeyK') saveBuild();
  if (event.code === 'KeyO') loadBuild();
  if (event.code === 'KeyP') { state.paused = !state.paused; toast(state.paused ? 'Paused' : 'Resumed'); }
  if (event.code === 'KeyR' && state.mode === 'build') { state.rotation += Math.PI / 2; updateGhostPosition(); toast('Rotated 90°'); }
  if (event.code === 'F1') settingsPanel.classList.toggle('hidden');
  if (event.code.startsWith('Digit')) {
    const index = Number(event.code.slice(5)) - 1;
    if (ORDER[index]) selectPart(ORDER[index], index);
  }
}

function onKeyUp(event) { keys.delete(event.code); }
function onMouseMove(event) {
  if (!state.locked) return;
  state.yaw -= event.movementX * state.sensitivity;
  state.pitch = THREE.MathUtils.clamp(state.pitch - event.movementY * state.sensitivity, -1.45, 1.45);
}
function onMouseDown(event) {
  if (!state.locked) { renderer.domElement.requestPointerLock(); return; }
  if (state.mode === 'build') {
    if (event.button === 0) placePart();
    if (event.button === 2) removeTarget();
  }
}

const playerBody = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 2, 8).setLinearDamping(0.3).setEnabledRotations(false, true, false));
world.createCollider(RAPIER.ColliderDesc.capsule(0.45, 0.55), playerBody);

document.addEventListener('keydown', onKeyDown);
document.addEventListener('keyup', onKeyUp);
document.addEventListener('mousemove', onMouseMove);
document.addEventListener('contextmenu', (event) => event.preventDefault());
renderer.domElement.addEventListener('mousedown', onMouseDown);
document.addEventListener('pointerlockchange', () => { state.locked = document.pointerLockElement === renderer.domElement; });
sensitivityInput.oninput = () => { state.sensitivity = Number(sensitivityInput.value); };
gravityInput.oninput = () => { world.gravity = { x: 0, y: Number(gravityInput.value), z: 0 }; };
snapInput.oninput = () => { state.snap = Number(snapInput.value); updateGhostPosition(); updateStatus(); };
$('close-settings').onclick = () => settingsPanel.classList.add('hidden');
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

addLights();
addGround();
addPart('wood', new THREE.Vector3(0, 1, 1));
addPart('wood', new THREE.Vector3(1, 1, 1));
addPart('wood', new THREE.Vector3(-1, 1, 1));
addPart('seat', new THREE.Vector3(0, 2, 1));
addPart('engine', new THREE.Vector3(0, 1.2, -1));
addPart('battery', new THREE.Vector3(0, 2.1, -2));
for (const p of [[-1.5, 0.5, -0.7], [1.5, 0.5, -0.7], [-1.5, 0.5, 1.8], [1.5, 0.5, 1.8]]) addPart('wheel', new THREE.Vector3(...p));
buildToolbar();
updateGhost();
updateStatus();

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);
  updateGhostPosition();
  if (!state.paused) {
    if (state.mode === 'play') { playerStep(); vehicleStep(dt); }
    evaluateLogic();
    world.step();
    for (const part of blocks) {
      const p = part.body.translation();
      part.mesh.position.set(p.x, p.y, p.z);
      const q = part.body.rotation();
      part.mesh.quaternion.set(q.x, q.y, q.z, q.w);
    }
    if (clock.elapsedTime - state.lastWireUpdate > 0.12) {
      drawWires();
      state.lastWireUpdate = clock.elapsedTime;
    }
  }
  renderer.render(scene, camera);
}

frame();
setTimeout(() => toast('Prototype ready'), 200);
window.__constructLab = { save: saveBuild, load: loadBuild, blocks, state };
