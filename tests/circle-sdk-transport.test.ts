import { createServer } from "node:http";
import { createRequire } from "node:module";
import { generateKeyPairSync, privateDecrypt, constants } from "node:crypto";
import { expect, it } from "vitest";
import { createCircleTransferAdapter, type CircleTransferClient } from "../apps/server/src/payments/circle.js";
import { ARC_CHAIN_ID, ARC_USDC_ADDRESS } from "@agentpay/core";

it("encodes exact persisted terms through the installed Circle SDK HTTP transport",async()=>{
  const require=createRequire(new URL("../apps/server/package.json",import.meta.url));
  const sdk=require("@circle-fin/developer-controlled-wallets") as {
    initiateDeveloperControlledWalletsClient(config:{apiKey:string;entitySecret:string;baseUrl:string}):CircleTransferClient
  };
  const {publicKey,privateKey}=generateKeyPairSync("rsa",{modulusLength:2048});
  const walletId="00000000-0000-4000-8000-000000000001",key="00000000-0000-4000-8000-000000000002";
  const walletAddress=`0x${"1".repeat(40)}`,recipient=`0x${"2".repeat(40)}`,entitySecret="a".repeat(64);
  const calls:{method:string;path:string;body:Record<string,unknown>}[]=[];
  const server=createServer((req,res)=>{void(async()=>{
    let raw="";for await(const chunk of req) raw+=String(chunk);
    const body=raw?JSON.parse(raw) as Record<string,unknown>:{};
    calls.push({method:req.method??"",path:req.url??"",body});
    res.setHeader("content-type","application/json");
    if(req.url?.endsWith("/config/entity/publicKey")) res.end(JSON.stringify({data:{publicKey:publicKey.export({type:"spki",format:"pem"})}}));
    else if(req.url?.endsWith(`/wallets/${walletId}`)) res.end(JSON.stringify({data:{wallet:{id:walletId,address:walletAddress,blockchain:"ARC-TESTNET",accountType:"EOA",custodyType:"DEVELOPER",state:"LIVE"}}}));
    else if(req.url?.endsWith("/developer/transactions/transfer")) res.end(JSON.stringify({data:{id:key,state:"INITIATED"}}));
    else {res.statusCode=404;res.end("{}");}
  })().catch(()=>{res.statusCode=500;res.end("{}");});});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  try {
    const address=server.address();if(!address || typeof address==="string") throw new Error("test server unavailable");
    // Test-only injected SDK client points exclusively at loopback, with generated synthetic credentials.
    const client=sdk.initiateDeveloperControlledWalletsClient({apiKey:"synthetic-key",entitySecret,baseUrl:`http://127.0.0.1:${address.port}`});
    const adapter=createCircleTransferAdapter({mode:"arc_testnet",apiKey:"synthetic-key",entitySecret,walletId,walletAddress,blockchain:"ARC-TESTNET"},client);
    await expect(adapter.submit({walletId,recipient,providerIdempotencyKey:key,chainId:ARC_CHAIN_ID,tokenAddress:ARC_USDC_ADDRESS,
      amountMicroUsdc:"9007199254740993",feeAllowanceMicroUsdc:"22",fee:{gasLimit:"21000",maxFeePerGasNative:"1000000001",maxPriorityFeePerGasNative:"100000000"}}))
      .resolves.toEqual({providerId:key,providerState:"INITIATED"});
    const posts=calls.filter(c=>c.method==="POST");expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toMatchObject({idempotencyKey:key,walletId,tokenAddress:ARC_USDC_ADDRESS,destinationAddress:recipient,
      amounts:["9007199254.740993"],gasLimit:"21000",maxFee:"1.000000001",priorityFee:"0.100000000"});
    expect(privateDecrypt({key:privateKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:"sha256"},Buffer.from(String(posts[0]!.body.entitySecretCiphertext),"base64")).toString("hex")).toBe(entitySecret);
  } finally {await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
},20000);
