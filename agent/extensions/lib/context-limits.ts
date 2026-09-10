/** Normalize capacities, not usage estimates. No family-name guesses or probing. */
export function positiveTokenLimit(value:unknown):number|undefined {
 const parsed=typeof value==='string'&&/^\d{1,10}$/.test(value)?Number(value):value;
 return typeof parsed==='number'&&Number.isSafeInteger(parsed)&&parsed>0?parsed:undefined;
}
/** Both advertised model and endpoint limits apply; missing/invalid facts do not win. */
export function boundedContextLimit(...values:unknown[]):number|undefined {
 const valid=values.map(positiveTokenLimit).filter((v):v is number=>v!==undefined);
 return valid.length?Math.min(...valid):undefined;
}
export function normalizeModelLimits<T extends {contextWindow:number;maxTokens:number}>(model:T):T {
 const context=positiveTokenLimit(model.contextWindow),output=positiveTokenLimit(model.maxTokens);
 if(context===undefined||output===undefined)throw Error('Model metadata has invalid context/output token limits');
 return {...model,contextWindow:context,maxTokens:Math.min(output,context)};
}
