import { expect, it } from "vitest";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { withCdpTab } from "./cdp-driver.js";

it.skipIf(process.env.VUTOOLKIT_LIVE !== "1")("answers a synthetic challenge using the real browser",async()=>{
  const {privateKey}=generateKeyPairSync("ec",{namedCurve:"prime256v1"});
  const credentialId=randomBytes(32).toString("base64");
  await withCdpTab(process.env.VUTOOLKIT_CDP_URL||"http://127.0.0.1:18800","about:blank",async(tab)=>{
    await tab.send("Page.enable");
    await tab.send("WebAuthn.enable",{enableUI:false});
    const {authenticatorId}=await tab.send<{authenticatorId:string}>("WebAuthn.addVirtualAuthenticator",{options:{protocol:"ctap2",transport:"internal",hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
    await tab.send("WebAuthn.addCredential",{authenticatorId,credential:{credentialId,isResidentCredential:false,rpId:"onevu.vanderbilt.edu",privateKey:privateKey.export({format:"der",type:"pkcs8"}).toString("base64"),userHandle:randomBytes(16).toString("base64"),signCount:1}});
    await tab.send("Page.navigate",{url:"https://onevu.vanderbilt.edu/favicon.ico"});
    for(let i=0;i<30;i++){
      if(await tab.evaluate("location.origin==='https://onevu.vanderbilt.edu'&&document.readyState==='complete'"))break;
      await new Promise(r=>setTimeout(r,500));
    }
    const result=await tab.evaluate(`(async()=>{try{const r=await navigator.credentials.get({publicKey:{challenge:crypto.getRandomValues(new Uint8Array(32)),rpId:'onevu.vanderbilt.edu',allowCredentials:[{type:'public-key',id:Uint8Array.from(atob(${JSON.stringify(credentialId)}),c=>c.charCodeAt(0)),transports:['internal']}],timeout:5000,userVerification:'preferred'}});return {ok:!!r};}catch(e){return {ok:false,name:e.name,message:e.message}}})()`);
    expect(result).toEqual({ok:true});
  },{isolated:true});
},60000);
