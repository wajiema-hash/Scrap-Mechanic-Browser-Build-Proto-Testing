import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
import RAPIER from 'https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.12.0/rapier.es.js';

await RAPIER.init();

const $ = (id) => document.getElementById(id);
const root = $('game-root');
const toolbar = $('toolbar');
const modePill = $('mode-pill');
const statusBar = $('status-bar');
const toastBox = $('toast');
const settings = $('settings-panel');
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
scene.add(wireGroup);

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
  logic: { label: 'AND Gate', color: 0xc678e8, size: [0.9, 0.9, 0.9], mass: 1, gate: 'and' },
  button: { label: 'Button', color: 0x35cba5, size: [0.7, 0.4, 0.7], mass: 0.7, source: true },
};
const ORDER = ['block', 'wood', 'metal', 'glass', 'seat', 'wheel', 'engine', 'largeEngine', 'motor', 'battery', 'logic', 'button'];

const state = {
  mode: 'build', selected: 'block', rotation: 0, snap: 1,
  yaw: 0, pitch: 0, sensitivity: Number(sensitivityInput.value),
  locked: false, driver: null, paused: false, lastWireUpdate: 0,
};

function showToast(text) {
  toastBox.textContent = text;
  toastBox.classList.add('visible');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toastBox.classList.remove('visible'), 1600);
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
  sun.position.set(25, 35, 15); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048); scene.add(sun);
}

function addGround() {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(140, 1, 140), new THREE.MeshStandardMaterial({ color: 0x4c6654, roughness: 0.9 }));
  mesh.position.y = -0.5; mesh.receiveShadow = true; scene.add(mesh);
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
  world.createCollider(RAPIER.ColliderDesc.cuboid(70, 0.5, 70), body);
}

function material(type) {
  const p = PARTS[type];
  return new THREE.MeshStandardMaterial({
    color: p.color, roughness: 0.7,
    metalness: ['metal', 'engine', 'largeEngine', 'motor'].includes(type) ? 0.7 : 0.12,
    transparent: !!p.transparent, opacity: p.transparent ? 0.52 : 1,
  });
}

function createMesh(type) {
  const p = PARTS[type];
  const geometry = p.wheel ? new THREE.CylinderGeometry(0.36, 0.36, 0.2, 24) : new THREE.BoxGeometry(...p.size);
  const mesh = new THREE.Mesh(geometry, material(type));
  mesh.castShadow = true; mesh.receiveShadow = true;
  if (p.wheel) mesh.rotation.z = Math.PI / 2;
  return mesh;
}

function createBody(mesh, type) {
  const p = PARTS[type];
  const d = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(mesh.position.x, mesh.position.y, mesh.position.z)
    .setLinearDamping(0.55).setAngularDamping(0.65);
  const body = world.createRigidBody(d);
  const collider = p.wheel ? RAPIER.ColliderDesc.cylinder(0.1, 0.36) : RAPIER.ColliderDesc.cuboid(p.size[0] / 2, p.size[1] / 2, p.size[2] / 2);
  collider.setFriction(p.wheel ? 1.4 : 0.8);
  world.createCollider(collider, body);
  return body;
}

function posKey(v) { return `${Math.round(v.x)}:${Math.round(v.y)}:${Math.round(v.z)}`; }

function addPart(type, position, rotation = 0) {
  if (!PARTS[type]) return null;
  const mesh = createMesh(type); mesh.position.copy(position); mesh.rotation.y = rotation;
  const block = { id: crypto.randomUUID(), type, mesh, body: null, rotation, signal: 0, key: posKey(position) };
  block.body = createBody(mesh, type);
  mesh.userData.block = block;
  blocks.push(block); scene.add(mesh); return block;
}

function removePart(block) {
  if (!block) return;
  scene.remove(block.mesh); world.removeRigidBody(block.body);
  const i = blocks.indexOf(block); if (i >= 0) blocks.splice(i, 1);
}

function buildToolbar() {
  toolbar.innerHTML = '';
  ORDER.forEach((type, i) => {
    const button = document.createElement('button'); button.className = 'part-slot';
    const p = PARTS[type];
    button.innerHTML = `<span class="part-color" style="background:#${p.color.toString(16).padStart(6, '0')}"></span><span>${i + 1}. ${p.label}</span>`;
    button.onclick = () => selectPart(type, i); toolbar.appendChild(button);
  });
  selectPart('block', 0);
}

function selectPart(type, index = ORDER.indexOf(type)) {
  state.selected = type;
  document.querySelectorAll('.part-slot').forEach((b, i) => b.classList.toggle('active', i === index));
  updateStatus();
}

function hitBlock() {
  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
  return raycaster.intersectObjects(blocks.map((b) => b.mesh))[0] || null;
}

function place() {
  const hit = hitBlock(); if (!hit) return;
  const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
  const point = hit.object.position.clone().add(normal.multiplyScalar(0.58));
  const p = new THREE.Vector3(
    Math.round(point.x / state.snap) * state.snap,
    Math.round(point.y / state.snap) * state.snap,
    Math.round(point.z / state.snap) * state.snap,
  );
  if (blocks.some((b) => b.key === posKey(p))) return;
  addPart(state.selected, p, state.rotation); showToast(`Placed ${PARTS[state.selected].label}`);
}

function removeTarget() {
  const hit = hitBlock(); if (!hit) return;
  const block = blocks.find((b) => b.mesh === hit.object);
  if (block) { removePart(block); showToast(`Removed ${PARTS[block.type].label}`); }
}

function switchMode() {
  state.mode = state.mode === 'build' ? 'play' : 'build';
  if (state.mode === 'build' && state.driver) exitSeat();
  showToast(`${state.mode === 'build' ? 'Build' : 'Play'} mode`); updateStatus();
}

function nearestSeat() {
  const p = playerBody.translation();
  return blocks.filter((b) => b.type === 'seat').sort((a, b) => {
    const da = Math.hypot(a.mesh.position.x - p.x, a.mesh.position.z - p.z);
    const db = Math.hypot(b.mesh.position.x - p.x, b.mesh.position.z - p.z);
    return da - db;
  })[0];
}

function enterSeat() {
  if (state.driver) { exitSeat(); return; }
  const seat = nearestSeat();
  if (!seat) { showToast('No seat nearby'); return; }
  const p = playerBody.translation();
  if (Math.hypot(seat.mesh.position.x - p.x, seat.mesh.position.z - p.z) > 3.5) { showToast('Seat is too far away'); return; }
  state.driver = seat; showToast('Entered seat'); updateStatus();
}

function exitSeat() {
  if (!state.driver) return;
  const p = state.driver.mesh.position.clone().add(new THREE.Vector3(0, 1.6, 2.4));
  playerBody.setTranslation({ x: p.x, y: p.y, z: p.z }, true);
  state.driver = null; showToast('Exited seat'); updateStatus();
}

function vehicleStep(dt) {
  if (!state.driver) return;
  const throttle = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
  const steer = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
  const forward = new THREE.Vector3(Math.sin(state.yaw), 0, Math.cos(state.yaw));
  const motors = blocks.filter((b) => ['engine', 'largeEngine', 'motor'].includes(b.type));
  const wheels = blocks.filter((b) => b.type === 'wheel');
  const power = motors.reduce((sum, b) => sum + PARTS[b.type].power, 0);
  const signal = blocks.some((b) => b.type === 'button' && b.signal > 0) || blocks.some((b) => b.type === 'battery') ? 1 : 0;
  const impulseStrength = throttle * power * signal * dt * 0.18;

  for (const wheel of wheels) {
    wheel.body.applyImpulse({ x: forward.x * impulseStrength, y: 0, z: forward.z * impulseStrength }, true);
    wheel.body.applyTorqueImpulse({ x: 0, y: steer * power * dt * 0.02, z: 0 }, true);
  }
  for (const motor of motors) {
    motor.body.applyImpulse({ x: forward.x * impulseStrength * 0.3, y: 0, z: forward.z * impulseStrength * 0.3 }, true);
  }

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
  const p = playerBody.translation(); camera.position.set(p.x, p.y + 1.2, p.z); camera.rotation.set(state.pitch, state.yaw, 0, 'YXZ');
}

function evaluateLogic() {
  const sources = blocks.filter((b) => ['battery', 'button'].includes(b.type));
  const gates = blocks.filter((b) => b.type === 'logic');
  for (const block of blocks) block.signal = 0;
  for (const source of sources) source.signal = source.type === 'battery' || keys.has('KeyL') ? 1 : 0;
  for (const gate of gates) {
    const inputs = sources.filter((s) => s.mesh.position.distanceTo(gate.mesh.position) < 3.2);
    gate.signal = inputs.length >= 2 && inputs.every((x) => x.signal > 0) ? 1 : 0;
  }
  for (const block of blocks) {
    if (['engine', 'largeEngine', 'motor'].includes(block.type)) {
      block.signal = blocks.some((x) => x.signal > 0 && x.mesh.position.distanceTo(block.mesh.position) < 3.2) ? 1 : 0;
    }
  }
}

function drawWires() {
  wireGroup.clear();
  const nodes = blocks.filter((b) => ['battery', 'button', 'logic', 'engine', 'largeEngine', 'motor'].includes(b.type));
  const points = [];
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    if (nodes[i].mesh.position.distanceTo(nodes[j].mesh.position) <= 3.2) points.push(nodes[i].mesh.position, nodes[j].mesh.position);
  }
  if (!points.length) return;
  const values = [];
  for (const p of points) values.push(p.x, p.y, p.z);
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(values, 3));
  wireGroup.add(new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0xffd45f, linewidth: 2 })));
}

function saveBuild() {
  localStorage.setItem('construct-lab-save-v2', JSON.stringify(blocks.map((b) => ({ type: b.type, x: b.mesh.position.x, y: b.mesh.position.y, z: b.mesh.position.z, rotation: b.rotation }))));
  showToast('Build saved');
}

function loadBuild() {
  const raw = localStorage.getItem('construct-lab-save-v2'); if (!raw) { showToast('No save found'); return; }
  for (const b of [...blocks]) removePart(b);
  for (const item of JSON.parse(raw)) addPart(item.type, new THREE.Vector3(item.x, item.y, item.z), item.rotation || 0);
  showToast('Build loaded');
}

function keyDown(e) {
  keys.add(e.code);
  if (e.code === 'Tab') { e.preventDefault(); switchMode(); }
  if (e.code === 'KeyE' && state.mode === 'play') enterSeat();
  if (e.code === 'KeyK') saveBuild(); if (e.code === 'KeyO') loadBuild();
  if (e.code === 'KeyR' && state.mode === 'build') { state.rotation += Math.PI / 2; showToast('Rotated 90°'); }
  if (e.code === 'F1') settings.classList.toggle('hidden');
  if (e.code.startsWith('Digit')) { const i = Number(e.code.slice(5)) - 1; if (ORDER[i]) selectPart(ORDER[i], i); }
}
function keyUp(e) { keys.delete(e.code); }
function mouseMove(e) {
  if (!state.locked) return;
  state.yaw -= e.movementX * state.sensitivity; state.pitch -= e.movementY * state.sensitivity;
  state.pitch = THREE.MathUtils.clamp(state.pitch, -1.45, 1.45);
}
function mouseDown(e) {
  if (!state.locked) { renderer.domElement.requestPointerLock(); return; }
  if (state.mode === 'build') e.button === 0 ? place() : e.button === 2 ? removeTarget() : null;
}

const playerBody = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 2, 8).setLinearDamping(0.3).setEnabledRotations(false, true, false));
world.createCollider(RAPIER.ColliderDesc.capsule(0.45, 0.55), playerBody);

document.addEventListener('keydown', keyDown); document.addEventListener('keyup', keyUp); document.addEventListener('mousemove', mouseMove);
renderer.domElement.addEventListener('mousedown', mouseDown); document.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('pointerlockchange', () => { state.locked = document.pointerLockElement === renderer.domElement; });
sensitivityInput.oninput = () => { state.sensitivity = Number(sensitivityInput.value); };
gravityInput.oninput = () => { world.gravity = { x: 0, y: Number(gravityInput.value), z: 0 }; };
snapInput.oninput = () => { state.snap = Number(snapInput.value); updateStatus(); };
$('close-settings').onclick = () => settings.classList.add('hidden');
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

addLights(); addGround();
addPart('wood', new THREE.Vector3(0, 1, 1)); addPart('wood', new THREE.Vector3(1, 1, 1)); addPart('wood', new THREE.Vector3(-1, 1, 1));
addPart('seat', new THREE.Vector3(0, 2, 1)); addPart('engine', new THREE.Vector3(0, 1.2, -1)); addPart('battery', new THREE.Vector3(0, 2.1, -2));
for (const p of [[-1.5, 0.5, -0.7], [1.5, 0.5, -0.7], [-1.5, 0.5, 1.8], [1.5, 0.5, 1.8]]) addPart('wheel', new THREE.Vector3(...p));
buildToolbar(); updateStatus();

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);
  if (!state.paused) {
    if (state.mode === 'play') { playerStep(); vehicleStep(dt); }
    evaluateLogic();
    world.step();
    for (const b of blocks) { const p = b.body.translation(); b.mesh.position.set(p.x, p.y, p.z); const q = b.body.rotation(); b.mesh.quaternion.set(q.x, q.y, q.z, q.w); }
    if (clock.elapsedTime - state.lastWireUpdate > 0.12) { drawWires(); state.lastWireUpdate = clock.elapsedTime; }
  }
  renderer.render(scene, camera);
}
frame();
setTimeout(() => showToast('Prototype ready'), 200);
window.__constructLab = { save: saveBuild, load: loadBuild, blocks, state };
