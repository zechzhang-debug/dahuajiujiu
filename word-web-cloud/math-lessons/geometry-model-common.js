document.querySelectorAll('.stage-slider').forEach(slider=>{const output=document.getElementById(slider.dataset.output);function update(){const n=Number(slider.value);document.querySelectorAll('[data-stage]').forEach(el=>{const s=Number(el.dataset.stage);el.style.opacity=s<=n?'1':'.08'});if(output)output.textContent=['只看原图','画第一步','画第二步','完整构造'][n]||('第'+n+'步')}slider.addEventListener('input',update);update()});
document.querySelectorAll('svg[aria-label="将军饮马轴对称最短路径图"]').forEach(svg=>svg.setAttribute('viewBox','0 0 720 440'));
const modelDirectoryByPage={
  'median-extension-model-proof.html':['junior2','congruence'],
  'cut-and-complete-model-proof.html':['junior2','congruence'],
  'one-line-three-equal-angles-congruence-proof.html':['junior2','congruence'],
  'three-perpendicular-congruence-model-proof.html':['junior2','congruence'],
  'hand-in-hand-congruence-model-proof.html':['junior2','congruence'],
  'square-half-angle-model-proof.html':['junior2','quadrilaterals'],
  'supplementary-angles-model-proof.html':['junior2','congruence'],
  'angle-bisector-congruence-model-proof.html':['junior2','congruence'],
  'bisector-parallel-isosceles-model-proof.html':['junior2','triangles'],
  'a-eight-similarity-model-proof.html':['junior3','similarity-models'],
  'dart-swallowtail-kite-model-proof.html':['junior2','triangles'],
  'general-horse-reflection-model-proof.html':['junior2','axial-symmetry']
};
const currentModelPage=location.pathname.split('/').pop();
const modelBackLink=document.querySelector('.back');
if(modelBackLink&&modelDirectoryByPage[currentModelPage]){
  const [modelGrade,modelTopic]=modelDirectoryByPage[currentModelPage];
  modelBackLink.href=`../math.html?grade=${modelGrade}&topic=${modelTopic}`;
  modelBackLink.textContent=`← 返回${modelGrade==='junior2'?'初二':'初三'}目录`;
}
