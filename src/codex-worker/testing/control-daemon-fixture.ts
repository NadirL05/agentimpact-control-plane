import {CodexControlDaemon} from '../control-daemon.js';
import {LocalWorkerServer,WorkerTransportAuthenticator,type SignedWorkerRequest} from '../../core/missions-v2/codex-transport.js';
import {CodexControlDispatcher} from '../../core/missions-v2/codex-controller.js';
import {codexWorkerConfig} from '../../core/missions-v2/codex-worker.js';
import {MissionError} from '../../core/missions-v2/model.js';

const socketPath=process.env.CONTROL_TEST_SOCKET;
const key=process.env.CONTROL_TEST_HMAC;
if(!socketPath||!key)throw new Error('fixture_config_missing');
const root=socketPath.slice(0,socketPath.lastIndexOf('/'));
const auth=new WorkerTransportAuthenticator(Buffer.from(key,'hex'));
const disabled=new CodexControlDispatcher({} as never,{} as never,async()=>{throw new MissionError('unexpected_assignment');},{} as never,
  ()=>({maxDiffBytes:1,requiredTests:[]}),codexWorkerConfig({}));
const dispatch:(request:SignedWorkerRequest)=>Promise<unknown>=process.env.CONTROL_TEST_ENABLED==='1'?async request=>{
  if(request.message.fencing_token!=='7')throw new MissionError('fencing_rejected',409);
  return{accepted:true,operation:request.message.operation};
}:request=>disabled.dispatch(request);
const server=new LocalWorkerServer(socketPath,auth,dispatch,root);
const daemon=new CodexControlDaemon(server,undefined);daemon.installSignalHandlers();await daemon.start();
