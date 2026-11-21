// Renders a Gemini-built part model with three.js, transparent so it sits over the live camera.
import React, { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

const FINISH = {
  fabric: { roughness: 0.95, metalness: 0 }, velvet: { roughness: 0.75, metalness: 0, sheen: 1 },
  boucle: { roughness: 1, metalness: 0 }, leather: { roughness: 0.55, metalness: 0 },
  wood: { roughness: 0.6, metalness: 0 }, rattan: { roughness: 0.85, metalness: 0 },
  metal: { roughness: 0.3, metalness: 0.85 }, plastic: { roughness: 0.4, metalness: 0 },
  glass: { roughness: 0.05, metalness: 0, transparent: true, opacity: 0.35 },
  ceramic: { roughness: 0.25, metalness: 0 }, stone: { roughness: 0.7, metalness: 0 },
};

function geometryFor(part) {
  const [x, y, z] = part.size_cm.map(v => Math.max(0.2, Math.abs(v)) / 100);
  switch (part.shape) {
    case "rounded_box": return new RoundedBoxGeometry(x, y, z, 4, Math.min(x, y, z) * 0.22);
    case "cylinder": return new THREE.CylinderGeometry(0.5, 0.5, 1, 32).scale(x, y, z);
    case "cone": return new THREE.ConeGeometry(0.5, 1, 32).scale(x, y, z);
    case "sphere": return new THREE.SphereGeometry(0.5, 32, 20).scale(x, y, z);
    default: return new THREE.BoxGeometry(x, y, z);
  }
}

function buildGroup(model) {
  const group = new THREE.Group();
  for (const part of model.parts ?? []) {
    const finish = FINISH[part.material] ?? FINISH.fabric;
    let color;
    try { color = new THREE.Color(part.color || "#bbbbbb"); } catch { color = new THREE.Color("#bbbbbb"); }
    const material = new THREE.MeshPhysicalMaterial({ color, ...finish });
    const mesh = new THREE.Mesh(geometryFor(part), material);
    mesh.position.set(...part.center_cm.map(v => v / 100));
    mesh.rotation.set(...(part.rotation_deg ?? [0, 0, 0]).map(d => THREE.MathUtils.degToRad(d)));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = part.name;
    group.add(mesh);
  }
  return group;
}

// A 170 cm person standing beside the product, so true size reads at a glance.
function scalePerson() {
  const person = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({ color: 0x8b93a7, roughness: 0.8, transparent: true, opacity: 0.55 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 1.12, 6, 16), skin);
  body.position.y = 0.17 + 0.56;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.115, 24, 16), skin);
  head.position.y = 1.70 - 0.115;
  for (const mesh of [body, head]) { mesh.castShadow = true; person.add(mesh); }
  person.name = "person-170cm";
  return person;
}

export const ModelView = forwardRef(function ModelView({ model, overlay, spin = true }, ref) {
  const host = useRef(null);
  const three = useRef(null);

  useEffect(() => {
    const node = host.current;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    node.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 50);
    camera.position.set(2.2, 1.4, 2.6);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.autoRotateSpeed = 1.6;
    scene.add(new THREE.HemisphereLight(0xfffcf2, 0x8a8577, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(2, 4, 3);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3 });
    scene.add(sun);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), new THREE.ShadowMaterial({ opacity: 0.32 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    const grid = new THREE.GridHelper(6, 30, 0x6f7f6b, 0xb7bfae);
    grid.material.transparent = true;
    grid.material.opacity = 0.35;
    scene.add(grid);
    const state = { renderer, scene, camera, controls, grid, group: null, frame: 0 };
    three.current = state;
    const resize = () => {
      const { clientWidth: w, clientHeight: h } = node;
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    resize();
    const loop = () => {
      state.frame = requestAnimationFrame(loop);
      controls.update();
      renderer.render(scene, camera);
    };
    loop();
    return () => {
      cancelAnimationFrame(state.frame);
      observer.disconnect();
      controls.dispose();
      renderer.dispose();
      node.removeChild(renderer.domElement);
    };
  }, []);

  useEffect(() => {
    const state = three.current;
    if (!state) return;
    if (state.group) {
      state.scene.remove(state.group);
      state.group.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
      state.group = null;
    }
    if (state.person) { state.scene.remove(state.person); state.person = null; }
    if (!model?.parts?.length) return;
    const group = buildGroup(model);
    state.scene.add(group);
    state.group = group;
    const productBox = new THREE.Box3().setFromObject(group);
    state.person = scalePerson();
    state.person.position.set(productBox.max.x + 0.45, 0, (productBox.min.z + productBox.max.z) / 2);
    state.person.visible = !overlay;
    state.scene.add(state.person);
    const box = productBox.clone();
    if (state.person.visible) box.union(new THREE.Box3().setFromObject(state.person));
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z);
    state.controls.target.copy(centre);
    state.camera.position.set(centre.x + radius * 1.25, centre.y + radius * 0.75, centre.z + radius * 1.6);
    state.controls.update();
  }, [model]);

  useEffect(() => {
    const state = three.current;
    if (!state) return;
    state.controls.autoRotate = spin;
    state.grid.visible = !overlay;
    if (state.person) state.person.visible = !overlay;
  }, [spin, overlay]);

  useImperativeHandle(ref, () => ({
    // A clean front-three-quarter render for the visual self-check.
    snapshot() {
      const state = three.current;
      if (!state?.group) return null;
      const personWasVisible = state.person?.visible;
      if (state.person) state.person.visible = false; // the visual check compares the product alone
      state.renderer.render(state.scene, state.camera);
      const png = state.renderer.domElement.toDataURL("image/png").split(",")[1];
      if (state.person) state.person.visible = personWasVisible;
      return png;
    },
  }), []);

  return <div className={overlay ? "model-view overlay" : "model-view"} ref={host} />;
});
