import * as THREE from './assets/three.module.js';
import {createOrganicAppearance} from './organic.js?v=19';
import {MechanicalMotion} from './motion.js?v=17';
import {BurstGait,createLegPose,legPose,supportTurn} from './gait.js?v=15';
import {SkidEffects} from './skid-effects.js?v=13';
import {PatrolBehavior} from './patrol.js?v=19';


const $ = id => document.getElementById(id);
const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;
const V = (x=0,y=0,z=0) => new THREE.Vector3(x,y,z);
const maxSprintSpeed=3;
const state = {mode:'roam',speed:1.25,size:.5,paused:false,feet:false,dark:false};
let width=innerWidth,height=innerHeight,time=0,restUntil=0,clickUntil=0;
let sprinting=false;
const patrol=new PatrolBehavior();
let heading=.4,headingSpeed=0,lastPointer=0,frameCount=0,diagnostic=0;
const position=V(),velocity=V(),goal=V(),pointer=V(),clickGoal=V();
const scene=new THREE.Scene();
const camera=new THREE.OrthographicCamera(-width/2,width/2,height/2,-height/2,.1,4000);
camera.position.set(0,1600,420);camera.lookAt(0,0,0);camera.updateMatrixWorld(true);
let renderer;
class CompatibleRenderer {
 constructor(){this.domElement=document.createElement('canvas');this.ctx=this.domElement.getContext('2d');this.shadowMap={};this.pixelRatio=1;this.isWebGLRenderer=false;}
 setPixelRatio(r){this.pixelRatio=r;this.setSize(width,height);}
 setSize(w,h){this.domElement.width=w*this.pixelRatio;this.domElement.height=h*this.pixelRatio;this.domElement.style.width=w+'px';this.domElement.style.height=h+'px';}
 setClearColor(){}
 render(){drawCompatible(this.ctx,this.pixelRatio);}
}
try {
 renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,powerPreference:'high-performance'});
} catch(error) { renderer=new CompatibleRenderer(); }
renderer.setSize(width,height);renderer.setPixelRatio(Math.min(devicePixelRatio,2));
renderer.domElement.setAttribute('data-renderer',renderer.isWebGLRenderer?'webgl':'canvas');
renderer.setClearColor(0,0);renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.25;
$('stage').append(renderer.domElement);
const hemi=new THREE.HemisphereLight(0xe3edff,0x797362,2.7);scene.add(hemi);
const key=new THREE.DirectionalLight(0xfff1d8,4.5);key.position.set(-200,500,180);key.castShadow=true;
key.shadow.mapSize.set(2048,2048);key.shadow.camera.left=-900;key.shadow.camera.right=900;
key.shadow.camera.top=900;key.shadow.camera.bottom=-900;key.shadow.camera.near=1;key.shadow.camera.far=1800;
key.shadow.normalBias=.5;key.shadow.bias=-.0001;key.shadow.radius=4;scene.add(key);
const rim=new THREE.DirectionalLight(0xc0d8ff,3.5);rim.position.set(100,250,-400);scene.add(rim);
const sideLight=new THREE.DirectionalLight(0xffffff,1.3);sideLight.position.set(400,60,200);scene.add(sideLight);
const ground=new THREE.Mesh(new THREE.PlaneGeometry(8000,8000),new THREE.ShadowMaterial({opacity:.16}));
ground.rotation.x=-Math.PI/2;ground.position.y=-.5;ground.receiveShadow=true;scene.add(ground);

// A neutral studio environment gives metal actual reflections without an external asset.
const envScene=new THREE.Scene();envScene.background=new THREE.Color('#798388');
for(const [x,y,z,sx,sy,sz,color] of [[-8,6,0,3,10,14,'#fffaf0'],[8,4,-5,2,7,9,'#a0b5ca'],[0,10,0,12,1,7,'#e7ecf0'],[0,-5,0,20,1,20,'#202325']]){
 const p=new THREE.Mesh(new THREE.BoxGeometry(sx,sy,sz),new THREE.MeshBasicMaterial({color}));p.position.set(x,y,z);envScene.add(p);
}
if(renderer.isWebGLRenderer){const pmrem=new THREE.PMREMGenerator(renderer);scene.environment=pmrem.fromScene(envScene,.08).texture;pmrem.dispose();}
const materials={
 shell:new THREE.MeshStandardMaterial({color:'#222b30',metalness:.91,roughness:.29}),
 edge:new THREE.MeshStandardMaterial({color:'#4c585d',metalness:.94,roughness:.24}),
 silver:new THREE.MeshStandardMaterial({color:'#9aa8ae',metalness:.98,roughness:.22}),
 dark:new THREE.MeshStandardMaterial({color:'#151b20',metalness:.72,roughness:.38}),
 cable:new THREE.MeshStandardMaterial({color:'#343c3d',metalness:.4,roughness:.48}),
 bronze:new THREE.MeshStandardMaterial({color:'#b59a70',metalness:.8,roughness:.3}),
 eye:new THREE.MeshStandardMaterial({color:'#ffd88a',emissive:'#e8a134',emissiveIntensity:2.8,metalness:.4,roughness:.18})
};
const sphereGeo=new THREE.SphereGeometry(1,16,10);
const cylinderGeo=new THREE.CylinderGeometry(1,1,1,12);
const up=V(0,1,0);
function mesh(geometry,material,parent=scene){const m=new THREE.Mesh(geometry,material);m.castShadow=true;m.receiveShadow=true;parent.add(m);return m;}
function ball(parent,r,mat=materials.dark){const m=mesh(sphereGeo,mat,parent);m.scale.setScalar(r);return m;}
function cylinder(parent,r1,r2,length,mat=materials.silver){return mesh(new THREE.CylinderGeometry(r1,r2,length,12),mat,parent);}
function segment(parent,mat){return mesh(cylinderGeo,mat,parent);}
function box(parent,x,y,z,mat){return mesh(new THREE.BoxGeometry(x,y,z),mat,parent);}

const body=new THREE.Group();scene.add(body);
const core=ball(body,1,materials.dark);core.scale.set(18,10,37);
const under=box(body,23,7,54,materials.edge);under.position.y=-4;
const spine=new THREE.Group();body.add(spine);
for(let i=0;i<9;i++){
 const rib=box(spine,8+(i%2)*2,4,4,materials.silver);rib.position.set(0,9-Math.abs(i-4)*.8,-30+i*7);rib.rotation.x=(i-4)*.02;
 const bolt=ball(spine,1.4,materials.bronze);bolt.position.set(0,12-Math.abs(i-4)*.8,-30+i*7);
}
// Faceted plates have a raised ridge, an exposed central spine and tapered ends.
function plate(side,z0,z1,outer0,outer1){
 const vertices=[side*3,9,z0, side*outer0,1,z0+5, side*outer1,2,z1-3, side*4,10,z1, side*(outer0*.57),16,(z0+z1)/2];
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));g.setIndex([0,1,4,1,2,4,2,3,4,3,0,4]);g.computeVertexNormals();
 const m=mesh(g,materials.shell,body);m.material.side=THREE.DoubleSide;
 const outline=new THREE.LineSegments(new THREE.EdgesGeometry(g,30),new THREE.LineBasicMaterial({color:0x657277,transparent:true,opacity:.4}));body.add(outline);
}
for(const side of [-1,1]){plate(side,-42,-13,10,23);plate(side,-15,12,23,24);plate(side,10,36,23,10);}
const face=ball(body,1,materials.shell);face.scale.set(12,8,11);face.position.set(0,0,-33);
for(const side of [-1,1]){
 const socket=ball(body,4,materials.edge);socket.position.set(side*5.2,2,-42);
 const eye=ball(body,2,materials.eye);eye.position.set(side*5.2,2.2,-45);
 const jaw=box(body,2.2,3,11,materials.silver);jaw.position.set(side*8,-4,-42);jaw.rotation.y=side*.2;
}
const tail=box(body,8,4,11,materials.edge);tail.position.set(0,2,39);tail.rotation.x=-.15;

const legs=[];
const markerMaterial=new THREE.MeshBasicMaterial({color:0x9b793f,transparent:true,opacity:.5,depthWrite:false,side:THREE.DoubleSide});
for(const side of [-1,1])for(let row=0;row<4;row++){
 const i=legs.length,group=new THREE.Group();scene.add(group);
 const hip=ball(group,6.8,materials.dark),hipCap=ball(group,4.8,materials.edge);
 const knee=ball(group,4.5,materials.dark),kneeCap=ball(group,2.5,materials.bronze);
 const ankle=ball(group,2.4,materials.edge);
 const upper=segment(group,materials.silver),lower=segment(group,materials.edge),tarsus=segment(group,materials.silver);
 const upperArmor=segment(group,materials.shell),lowerArmor=segment(group,materials.shell);
 const piston=segment(group,materials.silver),pistonCover=segment(group,materials.dark),cable=segment(group,materials.cable);
 const claws=[segment(group,materials.silver),segment(group,materials.silver)];
 for(const detail of [hipCap,kneeCap,piston,pistonCover,cable,...claws])detail.castShadow=false;
 const marker=mesh(new THREE.RingGeometry(5.5,6.2,24),markerMaterial,scene);marker.rotation.x=-Math.PI/2;marker.position.y=.1;marker.visible=false;marker.castShadow=false;
 const dot=mesh(new THREE.CircleGeometry(1.3,12),markerMaterial,scene);dot.rotation.x=-Math.PI/2;dot.position.y=.2;dot.visible=false;dot.castShadow=false;
 legs.push({side,row,i,group,hip,hipCap,knee,kneeCap,ankle,upper,lower,tarsus,upperArmor,lowerArmor,piston,pistonCover,cable,claws,marker,dot,
  localHip:V(side*[13,18,18,12][row],-1,[-27,-10,10,28][row]),localIdeal:V(side*[74,120,112,78][row],0,[-130,-48,49,130][row]),
  foot:V(),from:V(),to:V(),ideal:V(),pose:createLegPose(),swing:1,stepping:false,cooldown:0,initialized:false,
  gaitGroup:(row+(side>0?1:0))%2,phaseOffset:((row+(side>0?1:0))%2)*.5,lastSwingCycle:-1,contactCount:0,reachLimit:(row===0||row===3)?153:133,
  bendDirection:V(side*.85,.65,[-.8,-.25,.25,.8][row]),bendVelocity:V()});
}

const appearance=createOrganicAppearance(scene,body,legs);

const raycaster=new THREE.Raycaster(),floor=new THREE.Plane(V(0,1,0),0);
function screenPoint(x,y){raycaster.setFromCamera(new THREE.Vector2(x/width*2-1,1-y/height*2),camera);return raycaster.ray.intersectPlane(floor,V())||V();}
function boundedPoint(x,y){if(window.__spiderDesktop)return window.__spiderDesktop.boundedPoint(x,y);const margin=Math.min(width*.22,110*state.size);return screenPoint(clamp(x,margin,width-margin),clamp(y,100+margin*.4,height-70-margin*.5));}
function safeGoal(){
 const mobile=width<700;
 let px=lerp(mobile?.27:.18,mobile?.73:.81,Math.random())*width;
 let py=lerp(mobile?.37:.22,mobile?.56:.65,Math.random())*height;
 if(!mobile&&px>width-440&&py>height-390)py=height*.35;
 return screenPoint(px,py);
}
function chooseGoal(kind=patrol.nextLeg()){
 patrol.beginTravel(kind);
 const desktopGoal=window.__spiderDesktop?.chooseGoal(kind);
 if(desktopGoal){goal.copy(desktopGoal);return;}
 if(kind==='short'){
  const direction=V(0,0,-1).applyAxisAngle(up,heading+(patrol.random()-.5)*1.8);
  const candidate=position.clone().addScaledVector(direction,(65+patrol.random()*90)*state.size).project(camera);
  let px=(candidate.x+1)*width/2,py=(1-candidate.y)*height/2;
  if(width>=700&&px>width-440&&py>height-390)py=height*.35;
  goal.copy(boundedPoint(px,py));return;
 }
 let farthest=V(),best=0;
 for(let attempt=0;attempt<16;attempt++){
  const candidate=safeGoal(),distance=candidate.distanceTo(position);
  if(distance>best){farthest.copy(candidate);best=distance;}
  if(distance>220*state.size){goal.copy(candidate);return;}
 }
 goal.copy(farthest);
}
function init(){position.copy(screenPoint(width*.51,height*(width<700?.41:.43)));goal.copy(position);chooseGoal();}
init();
const motion=new MechanicalMotion(position,velocity,heading);
const gait=new BurstGait(legs);
const skidEffects=new SkidEffects(scene);
function skidRoom(target,velocity,size){
 if(window.__spiderDesktop)return window.__spiderDesktop.skidRoom(target,velocity,size);
 if(velocity.lengthSq()<1)return 0;
 const a=target.clone().project(camera),b=target.clone().add(velocity.clone().normalize()).project(camera);
 const x=(a.x+1)*width/2,y=(1-a.y)*height/2,dx=(b.x-a.x)*width/2,dy=(a.y-b.y)*height/2;
 // Leave room for the small forward rise underneath the planted front feet.
 const margin=Math.min(84*size,Math.min(width,height)*.22);
 const limits=[Infinity];
 if(Math.abs(dx)>1e-8)limits.push((dx>0?width-margin-x:margin-x)/dx);
 if(Math.abs(dy)>1e-8)limits.push((dy>0?height-margin-y:margin-y)/dy);
 return Math.max(0,Math.min(...limits));
}
function updateMotion(dt){
 const desktopManual=!!window.__spiderDesktop?.manualActive;
 const manual=time<clickUntil||sprinting||desktopManual;
 const autonomous=state.mode==='roam'&&!manual;
 const settled=!motion.arriving&&velocity.length()<8*state.size/1.5&&(motion.isAtGoal(goal,state.size)||position.distanceTo(goal)<30*state.size/1.5);
 const delta=goal.clone().sub(position),wanted=Math.atan2(-delta.x,-delta.z);
 const headingError=Math.atan2(Math.sin(wanted-motion.heading),Math.cos(wanted-motion.heading));
 const idle=!autonomous&&!desktopManual&&velocity.length()<.01&&(state.mode==='observe'||settled);
 const decision=patrol.tick(dt,{enabled:autonomous,settled,idle,arriving:motion.arriving,headingError});
 if(state.mode==='roam'){
  if(decision.requestMove)chooseGoal();
 } else if(state.mode==='follow'){
  if(lastPointer>0)goal.copy(pointer);
  else goal.copy(position);
 } else goal.copy(position);
 if(manual&&(state.mode!=='observe'||desktopManual))goal.copy(clickGoal);
 const desktopGoal=window.__spiderDesktop?.updateGoal({autonomous,manual});
 if(desktopGoal)goal.copy(desktopGoal);
 // Give a completed desktop walk the same arrival pause as a dash, even
 // when a slow cross-display route outlasts the original click timeout.
 if(desktopManual&&!window.__spiderDesktop.manualActive&&!sprinting){
  clickUntil=Math.max(clickUntil,time+1.2);
 }
 // A desktop command temporarily permits movement without changing the
 // selected mode. Observe resumes as soon as the manual route finishes.
 const moving=state.mode!=='observe'||!!window.__spiderDesktop?.manualActive;
 const s=state.size,driveSpeed=sprinting?maxSprintSpeed:state.speed*(autonomous?patrol.travelFactor:1),gesture=patrol.pose;
 const previousHeading=motion.heading,previousRoot=position.clone();
 motion.tick(dt,{goal,moving,size:s,speed:driveSpeed,mode:sprinting?'sprint':state.mode,sprint:sprinting,skidLimit:skidRoom(goal,velocity,s),preciseArrival:sprinting&&!!window.__spiderDesktop?.preciseArrival});
 const requested=motion.heading-previousHeading;
 const allowed=supportTurn(legs,position,previousHeading,requested);
 motion.heading=previousHeading+allowed;motion.appliedAngularVelocity=dt>0?allowed/dt:0;
 if(Math.abs(allowed-requested)>1e-8){
  const pace=velocity.length();velocity.set(-Math.sin(motion.heading)*pace,0,-Math.cos(motion.heading)*pace);
  position.copy(previousRoot).addScaledVector(velocity,dt);
 }
 heading=motion.heading;headingSpeed=motion.angularVelocity;
 body.position.copy(position).add(motion.pose.lag).add(V(gesture.leanX,0,gesture.leanZ).multiplyScalar(s).applyAxisAngle(up,heading));
 body.position.y=s*(27-motion.crouch+motion.pose.height+gesture.height);
 body.scale.setScalar(s);body.rotation.set(motion.pose.pitch+gesture.bodyPitch,heading+gesture.bodyYaw,motion.pose.roll+gesture.bodyRoll,'YXZ');body.updateMatrixWorld(true);
 for(const l of legs)l.hip.position.copy(l.localHip).applyMatrix4(body.matrixWorld);
 gait.tick(dt,position,heading,motion,s,driveSpeed,moving&&!motion.isAtGoal(goal,s)&&goal.distanceTo(position)>25*s/1.5);
 for(const l of legs)solveLeg(l,s);
 appearance.update(s,heading+gesture.bodyYaw,gesture);
 skidEffects.update(dt,motion,legs,state);
 diagnostic=Math.max(...legs.map(l=>l.foot.distanceTo(l.ideal)/s));
 if(sprinting&&!motion.arriving&&velocity.length()<1&&(motion.isAtGoal(goal,s)||position.distanceTo(goal)<=(window.__spiderDesktop?.manualActive?2:30)*s/1.5)){sprinting=false;clickUntil=time+1.2;}
}

function solveLeg(l,s){
 // Organic rendering and contact checks only consume the joint positions.
 const {knee,ankle}=legPose(l,position,heading,s,l.pose),foot=l.foot;
 l.knee.position.copy(knee);l.ankle.position.copy(ankle);
 l.marker.visible=l.dot.visible=state.feet;
 l.marker.position.set(foot.x,.12,foot.z);l.marker.scale.setScalar(l.stepping?.7:1+Math.max(0,1-l.contactAge/.18)*.7);
 l.dot.position.set(foot.x,.2,foot.z);
}

// CPU drawing uses the very same articulated 3D pose when WebGL is unavailable.
function drawCompatible(ctx,dpr){
 appearance.draw(ctx,dpr,width,height,camera,state,position);
 skidEffects.draw(ctx,dpr,width,height,camera,state);
}

updateMotion(0);
const simulationStep=1/120;
let last=performance.now(),accumulator=0,lastInterfaceUpdate=0,fpsStart=last,renderedFrames=0,renderWork=0;
const renderObjects=[body,...legs.flatMap(l=>[...l.group.children,l.marker,l.dot])].map(object=>({
 object,previousPosition:object.position.clone(),previousQuaternion:object.quaternion.clone(),previousScale:object.scale.clone(),
 currentPosition:V(),currentQuaternion:new THREE.Quaternion(),currentScale:V()
}));
const renderFeet=legs.map(l=>({leg:l,previous:l.foot.clone(),current:V()}));
function capturePreviousPose(){
 for(const r of renderObjects){r.previousPosition.copy(r.object.position);r.previousQuaternion.copy(r.object.quaternion);r.previousScale.copy(r.object.scale);}
 for(const r of renderFeet)r.previous.copy(r.leg.foot);
}
function renderInterpolated(alpha){
 for(const r of renderObjects){
  const o=r.object;r.currentPosition.copy(o.position);r.currentQuaternion.copy(o.quaternion);r.currentScale.copy(o.scale);
  o.position.lerpVectors(r.previousPosition,r.currentPosition,alpha);o.quaternion.slerpQuaternions(r.previousQuaternion,r.currentQuaternion,alpha);o.scale.lerpVectors(r.previousScale,r.currentScale,alpha);
 }
 for(const r of renderFeet){r.current.copy(r.leg.foot);r.leg.foot.lerpVectors(r.previous,r.current,alpha);}
 body.updateMatrixWorld(true);renderer.render(scene,camera);
 // Display interpolation never feeds back into contact constraints or controller velocity.
 for(const r of renderObjects){r.object.position.copy(r.currentPosition);r.object.quaternion.copy(r.currentQuaternion);r.object.scale.copy(r.currentScale);}
 for(const r of renderFeet)r.leg.foot.copy(r.current);
 body.updateMatrixWorld(true);
}
function animate(now){
 requestAnimationFrame(animate);
 const workStart=performance.now();
 const elapsed=clamp((now-last)/1000,0,.25);last=now;
 if(!state.paused){
  accumulator+=elapsed;
  while(accumulator+1e-9>=simulationStep){capturePreviousPose();time+=simulationStep;frameCount++;updateMotion(simulationStep);accumulator=Math.max(0,accumulator-simulationStep);}
 }
 renderInterpolated(accumulator/simulationStep);
 if(now-lastInterfaceUpdate>100){
  const p=position.clone().project(camera);$('coordinates').textContent=`X ${String(Math.round((p.x+1)*width/2)).padStart(4,'0')} · Y ${String(Math.round((1-p.y)*height/2)).padStart(4,'0')}`;
  $('stateLabel').textContent=state.paused?'已暂停':state.mode==='observe'?'原地观察':sprinting&&!motion.arriving?'全速冲刺':patrol.observing||(patrol.active&&patrol.leg==='short'&&motion.phase==='charge')?patrol.label:motion.label;lastInterfaceUpdate=now;
 }
 renderedFrames++;renderWork+=performance.now()-workStart;
 if(now-fpsStart>=1000){
  renderer.domElement.setAttribute('data-fps',String(Math.round(renderedFrames*1000/(now-fpsStart))));
  renderer.domElement.setAttribute('data-work-ms',(renderWork/renderedFrames).toFixed(1));
  renderedFrames=0;renderWork=0;fpsStart=now;
 }
}
requestAnimationFrame(animate);
window.addEventListener('resize',()=>{
 width=innerWidth;height=innerHeight;camera.left=-width/2;camera.right=width/2;camera.top=height/2;camera.bottom=-height/2;camera.updateProjectionMatrix();renderer.setSize(width,height);
 const p=position.clone().project(camera);if(Math.abs(p.x)>.75||Math.abs(p.y)>.7){init();legs.forEach(l=>{l.initialized=false;l.stepping=false;});updateMotion(0);}
 chooseGoal();capturePreviousPose();accumulator=0;
});
window.addEventListener('pointermove',event=>{if(event.target.closest('button,input,aside'))return;pointer.copy(boundedPoint(event.clientX,event.clientY));lastPointer=time+1;});
function commandMove(event,fast=false){
 if(event.button!==undefined&&event.button!==0)return;
 if(state.mode==='observe'&&!window.__spiderDesktop)setMode('roam');
 const destination=boundedPoint(event.clientX,event.clientY);
 if(window.__spiderDesktop?.manualCommand(destination)===false)return;
 sprinting=fast;
 clickGoal.copy(destination);clickUntil=time+6;restUntil=0;motion.wake();
 const ripple=document.createElement('div');Object.assign(ripple.style,{position:'fixed',left:event.clientX+'px',top:event.clientY+'px',width:'28px',height:'28px',border:'1px solid var(--accent)',borderRadius:'50%',pointerEvents:'none',transform:'translate(-50%,-50%)'});document.body.append(ripple);
 ripple.animate([{opacity:.65,scale:.3},{opacity:0,scale:2}],{duration:650}).onfinish=()=>ripple.remove();
}
renderer.domElement.addEventListener('pointerdown',event=>commandMove(event));
renderer.domElement.addEventListener('dblclick',event=>{event.preventDefault();commandMove(event,true);});
function setMode(mode){state.mode=mode;sprinting=false;clickUntil=0;restUntil=0;motion.wake();document.querySelectorAll('[data-mode]').forEach(b=>{b.classList.toggle('selected',b.dataset.mode===mode);b.setAttribute('aria-pressed',String(b.dataset.mode===mode));});if(mode==='roam')chooseGoal();$('hint').innerHTML=mode==='follow'?'移动光标引导，双击位置全速冲刺':mode==='observe'?'观察它的机械关节与支撑姿态':'单击走过去 · 双击全速冲刺 <span class="key">↗</span>';}
document.querySelectorAll('[data-mode]').forEach(b=>b.addEventListener('click',()=>setMode(b.dataset.mode)));
$('speed').addEventListener('input',event=>{state.speed=Number(event.target.value);$('speedValue').textContent=state.speed.toFixed(2)+'×';});
$('size').addEventListener('input',event=>{state.size=Number(event.target.value);$('sizeValue').textContent=state.size.toFixed(2)+'×';});
$('size').value=state.size;$('sizeValue').textContent=state.size.toFixed(2)+'×';
$('feet').addEventListener('click',()=>{state.feet=!state.feet;$('feet').setAttribute('aria-pressed',String(state.feet));if(state.paused)legs.forEach(l=>l.marker.visible=l.dot.visible=state.feet);});
function pause(){state.paused=!state.paused;$('pause').innerHTML=state.paused?'继续 <span>▷</span>':'暂停 <span>Ⅱ</span>';$('stateLabel').textContent=state.paused?'已暂停':'正在探索';}
$('pause').addEventListener('click',pause);
$('theme').addEventListener('click',()=>{state.dark=!state.dark;document.body.classList.toggle('dark',state.dark);ground.material.opacity=state.dark?.35:.16;renderer.toneMappingExposure=state.dark?1.5:1.25;});
$('fullscreen').addEventListener('click',async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else if(document.documentElement.requestFullscreen)await document.documentElement.requestFullscreen();else $('hint').textContent='当前浏览器暂不支持全屏，可隐藏工具栏观察';}catch{$('hint').textContent='请在独立标签页中使用全屏';}});
window.addEventListener('keydown',e=>{if(e.code==='Space'&&!['INPUT','BUTTON'].includes(document.activeElement.tagName)){e.preventDefault();pause();}});
document.addEventListener('visibilitychange',()=>{last=performance.now();});
window.__spider={state,legs,position,velocity,goal,renderer,camera,scene,motion,gait,appearance,patrol,
 commandMove,
 cancelManual(){sprinting=false;clickUntil=0;motion.skid=null;skidEffects.age=1;
  window.__spiderDesktop?.cancelManual();
  for(const effect of [...skidEffects.marks,...skidEffects.puffs])effect.mesh.visible=false;
  motion.setPhase(velocity.length()>3?'charge':'idle');motion.wake();},
 get sprinting(){return sprinting;},get diagnostics(){return{frameCount,phase:motion.phase,patrol:patrol.phase,speed:velocity.length(),sprinting,maxFootError:diagnostic,stepping:legs.filter(l=>l.stepping).length,finite:legs.every(l=>[l.foot.x,l.foot.y,l.foot.z].every(Number.isFinite))};}};
