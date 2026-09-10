import { Type } from 'typebox';
import { contextSlice, symbolExpand, astDiff, boundResult } from './context-code.mjs';
import { expandWithLsp } from './context-lsp.mjs';
const lspAdapter=expandWithLsp;
export function registerContextCodeTools(pi) {
  if(process.env.PI_CONTEXT_TOOLS==='off'||process.env.PI_REASONING_AIDS==='off')return;
  const paths=Type.Array(Type.String(),{minItems:1,maxItems:20,description:'Explicit source files inside current workspace; no recursive scans.'});
  const maxChars=Type.Optional(Type.Integer({minimum:1200,maximum:32000,description:'Entire JSON output budget; default 12000.'}));
  const definitions=[
    {name:'context_slice',description:'Return fresh AST function/class bodies and imports ranked by task identifiers, with hashes and omitted coverage. JS/TS/Python; other languages report unsupported. Does not register read-before-edit coverage.',parameters:Type.Object({task:Type.String({maxLength:8192}),paths,maxChars}),run:contextSlice},
    {name:'symbol_expand',description:'Bounded AST callers/callees/type-name candidates within explicit files. Optional existing active LSP augments exact references/types. Name matches are not resolved bindings.',parameters:Type.Object({symbol:Type.String({maxLength:256}),paths,maxHops:Type.Optional(Type.Integer({minimum:0,maximum:3})),maxNodes:Type.Optional(Type.Integer({minimum:1,maximum:40})),maxChars}),run:symbolExpand},
    {name:'ast_diff',description:'Compress local Git base versus working-file, or supplied before/after JS/TS/Python source into structural symbol/signature/parameter/call/branch changes. Reports unsupported/syntax errors honestly; never executes project code; Git mode reads blobs only.',parameters:Type.Object({path:Type.String(),base:Type.Optional(Type.String({description:'Git commit/ref such as HEAD; mutually exclusive with before/after.'})),before:Type.Optional(Type.String({maxLength:262144})),after:Type.Optional(Type.String({maxLength:262144})),maxChars}),run:astDiff}
  ];
  for(const definition of definitions) pi.registerTool({name:definition.name,label:definition.name.replaceAll('_',' '),description:definition.description,parameters:definition.parameters,
    async execute(id,params,signal,_update,ctx) {
      try {
        if(process.env.PI_CONTEXT_TOOLS==='off'||process.env.PI_REASONING_AIDS==='off')throw new Error('Context tools disabled');
        let result=await definition.run({...params,cwd:ctx.cwd,signal});
        if(definition.name==='symbol_expand' && result.nodes?.length && lspAdapter) {
          // A single unambiguous root only. No automatic server install/start in adapter.
          if(!result.ambiguous) {
            const node=result.nodes[0];
            result.lsp=await lspAdapter({id,path:node.path,line:node.nameLine??node.startLine,character:node.nameCharacter??1,symbol:params.symbol.split('.').at(-1),signal,ctx});
          }
          result=boundResult(result,params.maxChars);
        }
        if(signal?.aborted)throw new Error('Cancelled');
        return {content:[{type:'text',text:JSON.stringify(result)}],details:result};
      } catch(error) {return {isError:true,content:[{type:'text',text:`${definition.name}: ${error.message}`}],details:{available:false}};}
    }
  });
}
