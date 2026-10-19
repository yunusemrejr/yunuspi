import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const release = path.resolve(import.meta.dirname, "..");
const agent = fs.existsSync(path.join(release, "agent"))
  ? path.join(release, "agent")
  : path.resolve(release, "..");
const lib = (name) => import(pathToFileURL(path.join(agent, "extensions/lib/", name)));
const { noteQualityReviewCompleted, lastQualityReviewCompletedAt, registerSharedQualityReview, settleSharedQualityReview } = await lib("quality-review-owner.ts");

let sessionSerial = 0;

test("completion rendezvous is scoped per session and total on bad input", () => {
  const a = { cwd: "/fixture/a", sessionManager: { getSessionId: () => "gating-a" } };
  const b = { cwd: "/fixture/a", sessionManager: { getSessionId: () => "gating-b" } };
  assert.equal(lastQualityReviewCompletedAt(a), undefined);
  noteQualityReviewCompleted(a, 1234567890);
  assert.equal(lastQualityReviewCompletedAt(a), 1234567890);
  assert.equal(lastQualityReviewCompletedAt(b), undefined);
  assert.equal(lastQualityReviewCompletedAt({}), undefined);
  assert.equal(lastQualityReviewCompletedAt(undefined), undefined);
  assert.doesNotThrow(() => noteQualityReviewCompleted({}));
  assert.doesNotThrow(() => noteQualityReviewCompleted(undefined));
});

test('shared review drops a result when its caller aborts or changes sessions while awaiting',async()=>{
  for(const mode of ['abort','session']){
    let session='fixture-review-owner-'+mode, release;
    const wait=new Promise(resolve=>release=resolve), controller=new AbortController();
    const ctx={cwd:'/fixture/shared-review',signal:controller.signal,sessionManager:{getSessionId:()=>session}};
    const unregister=registerSharedQualityReview(ctx,{owner:{},available:()=>true,settle:()=>wait,snapshot:()=>({status:'old advice'})});
    const pending=settleSharedQualityReview(ctx);
    if(mode==='abort')controller.abort();else session='replacement-session';
    release();
    assert.equal(await pending,undefined,mode);
    unregister();
  }
});
