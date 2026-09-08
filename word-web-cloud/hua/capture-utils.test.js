import test from 'node:test';
import assert from 'node:assert/strict';
import { directIdeaFrom, hasExplicitTodoSignal, inferIdeaTheme, isLongForm, needsAiAnalysis } from './capture-utils.js';

test('plain thoughts skip AI',()=>{
  assert.equal(needsAiAnalysis('人与人之间的信任，来自每一次小事'),false);
  assert.equal(needsAiAnalysis('这个视频开头可以用一个反常识问题'),false);
});

test('time and action intent use AI',()=>{
  assert.equal(needsAiAnalysis('明天下午三点提醒我和小林开会'),true);
  assert.equal(needsAiAnalysis('买牛奶'),true);
  assert.equal(needsAiAnalysis('周五把方案提交给客户'),true);
  assert.equal(needsAiAnalysis('今天想到一个视频开头'),false);
});

test('direct ideas keep line breaks and full content',()=>{
  const content='第一段灵感\n\n第二段继续展开';
  const idea=directIdeaFrom(content,{id:'1',createdAt:'now'});
  assert.equal(idea.content,content);
  assert.equal(idea.source,content);
});

test('long copy defaults to one idea unless it has an explicit todo signal',()=>{
  const longThought=`我在想内容创作的长期价值。${'这是一段当时想到的灵感。'.repeat(90)}`;
  assert.equal(isLongForm(longThought),true);
  assert.equal(isLongForm('想'.repeat(100)),false);
  assert.equal(isLongForm('想'.repeat(101)),true);
  assert.equal(hasExplicitTodoSignal(longThought),false);
  assert.equal(hasExplicitTodoSignal(`${longThought}\n提醒我明天下午三点联系小林`),true);
});

test('direct ideas infer a local theme',()=>{
  const idea=directIdeaFrom('这个视频可以从家长焦虑切入',{id:'1',createdAt:'now'});
  assert.equal(idea.theme,'创作');
  assert.equal(inferIdeaTheme('今天学到一个数学方法'),'学习');
});
