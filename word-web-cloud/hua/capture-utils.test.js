import test from 'node:test';
import assert from 'node:assert/strict';
import { directIdeaFrom, inferIdeaTheme, needsAiAnalysis } from './capture-utils.js';

test('plain thoughts skip AI',()=>{
  assert.equal(needsAiAnalysis('人与人之间的信任，来自每一次小事'),false);
  assert.equal(needsAiAnalysis('这个视频开头可以用一个反常识问题'),false);
});

test('time and action intent use AI',()=>{
  assert.equal(needsAiAnalysis('明天下午三点提醒我和小林开会'),true);
  assert.equal(needsAiAnalysis('买牛奶'),true);
  assert.equal(needsAiAnalysis('周五把方案提交给客户'),true);
});

test('direct ideas keep full content and infer a local theme',()=>{
  const idea=directIdeaFrom('这个视频可以从家长焦虑切入',{id:'1',createdAt:'now'});
  assert.equal(idea.content,'这个视频可以从家长焦虑切入');
  assert.equal(idea.theme,'创作');
  assert.equal(inferIdeaTheme('今天学到一个数学方法'),'学习');
});
