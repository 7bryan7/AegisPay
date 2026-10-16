import {expect,test,type Page} from "@playwright/test";
test.setTimeout(60000);
async function login(page:Page,path='/dashboard',reviewer=false){await page.goto(path);await page.getByLabel('Access code').fill(reviewer?'synthetic-reviewer-code':'synthetic-operator-code');await page.getByRole('button',{name:'Sign in',exact:true}).click();}
async function toggleTreasury(page:Page,pause:boolean){await page.goto('/dashboard/treasury');await page.getByRole('button',{name:pause?'Pause treasury':'Resume treasury',exact:true}).click();await page.getByLabel('Pause or resume reason').fill('Explicit isolated browser test');await page.getByRole('button',{name:pause?'Confirm pause':'Confirm resume',exact:true}).click();await expect(page.getByRole('button',{name:pause?'Resume treasury':'Pause treasury',exact:true})).toBeVisible();}

test('landing enters the workspace and invoice detail survives reload with a private export',async({page})=>{
 await page.goto('/');await expect(page.getByRole('heading',{name:'Every invoice. A clear decision.'})).toBeVisible();await page.getByRole('link',{name:'Open treasury workspace'}).first().click();await page.getByLabel('Access code').fill('synthetic-operator-code');await page.getByRole('button',{name:'Sign in',exact:true}).click();
 await page.getByRole('link',{name:'Upload invoice',exact:true}).click();await page.getByLabel('Invoice image').setInputFiles('fixtures/synthetic-invoice.png');await page.getByRole('button',{name:'Save invoice',exact:true}).click();await expect(page).toHaveURL(/\/dashboard\/invoices\/[a-f0-9-]+$/,{timeout:20000});await expect(page.getByText('No verified decision yet.')).toBeVisible();await expect(page.getByText('No transfer initiated.',{exact:true})).toBeVisible();await page.reload();await expect(page.getByRole('heading',{name:'Invoice detail',exact:true})).toBeVisible();
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'Export activity'}).click();expect((await download).suggestedFilename()).toMatch(/activity.json$/);
 await page.goto('/dashboard/invoices/new');await page.getByLabel('Invoice image').setInputFiles('fixtures/synthetic-invoice.png');await page.getByRole('button',{name:'Save invoice'}).click();await expect(page.getByRole('status')).toContainText('already saved');
});
test('reviewer mobile navigation cannot load operator records',async({page})=>{
 await page.setViewportSize({width:390,height:844});const privateRequests:string[]=[];page.on('request',r=>{if(/\/api\/(workspace|invoices|vendors|purchase-orders|payments|activity)/.test(r.url()))privateRequests.push(r.url());});
 await login(page,'/dashboard/payments',true);await expect(page.getByText('Private business records and payment controls are unavailable to this role.')).toBeVisible();await expect(page.getByRole('heading',{name:'Payments',exact:true})).toHaveCount(0);expect(privateRequests).toEqual([]);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.getByRole('button',{name:'Menu',exact:true}).click();await expect(page.getByRole('link',{name:'Reviewer examples',exact:true})).toBeVisible();await expect(page.locator('#workspace-nav')).toHaveCSS('flex-direction','column');await page.keyboard.press('Escape');await expect(page.locator('#workspace-nav')).toHaveCSS('visibility','hidden');await expect(page.getByRole('button',{name:'Menu',exact:true})).toBeFocused();
});
test('owner corrections and reevaluation remain versioned without invented payment',async({page})=>{
 await login(page,'/dashboard/invoices/new');const {readFile}=await import('node:fs/promises');const png=await readFile('fixtures/synthetic-invoice.png');await page.getByLabel('Invoice image').setInputFiles({name:'review.png',mimeType:'image/png',buffer:Buffer.concat([png,Buffer.from('owner-review-scenario')])});await page.getByRole('button',{name:'Save invoice'}).click();
 await page.getByLabel('Review reason',{exact:true}).fill('Checked independent PO evidence');await page.getByLabel('Field to correct').selectOption('dueDate');await page.getByLabel('Corrected value').fill('2026-10-09');await page.getByLabel('Independent evidence reference').fill('owner:accepted-po');await page.getByRole('button',{name:'Save correction'}).click();await expect(page.getByRole('status')).toContainText('Correction recorded');await expect(page.getByText('Synthetic review recorded.',{exact:false})).toBeVisible();
 await page.getByLabel('Review reason',{exact:true}).fill('Recheck corrected evidence');await page.getByRole('button',{name:'Re-evaluate invoice',exact:true}).click();await expect(page.getByRole('status')).toContainText('Re-evaluation queued');await expect(page.getByText('No transfer initiated.',{exact:true})).toBeVisible();
 await page.getByLabel('Review reason',{exact:true}).fill('Decline the isolated test obligation');await page.getByRole('button',{name:'Reject invoice',exact:true}).click();await expect(page.getByRole('dialog',{name:'Reject invoice',exact:true})).toBeVisible();await page.getByRole('button',{name:'Close',exact:true}).click();await page.getByRole('button',{name:'Reject invoice',exact:true}).click();await page.getByRole('button',{name:'Confirm rejection',exact:true}).click();await expect(page.getByRole('status')).toContainText('Invoice rejected');
});
test('backend outage cannot substitute a fake workspace',async({page})=>{
 await page.route('**/api/session',r=>r.abort());await page.goto('/dashboard');await expect(page.getByRole('status')).toContainText('API unavailable');await expect(page.getByRole('button',{name:'Sign in',exact:true})).toBeDisabled();
});
test('exact approval confirmation and reasoned pause preserve isolated fixture settlement evidence',async({page})=>{
 await login(page,'/dashboard/treasury');await toggleTreasury(page,false);await toggleTreasury(page,true);await page.goto('/dashboard/invoices/new');await page.getByLabel('Purchase order reference (optional)').fill('SYNTHETIC-PAYMENT-SCENARIO');await page.getByLabel('Invoice image').setInputFiles('fixtures/synthetic-invoice-2.png');await page.getByRole('button',{name:'Save invoice'}).click();await expect(page.getByRole('region',{name:'Decision explanation',exact:true}).getByText('Synthetic amount exceeds automatic threshold.',{exact:true})).toBeVisible();const invoice=page.url();await page.getByLabel('Operator approval rationale').fill('Synthetic exact approval');await page.getByRole('button',{name:'Approve invoice',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('1.500000 USDC');await page.getByRole('button',{name:'Confirm approval',exact:true}).click();await expect(page.getByText('No transfer initiated.',{exact:true})).toBeVisible();await toggleTreasury(page,false);await page.goto(invoice);await expect(page.getByText('Synthetic settlement fixture. No real transfer occurred.',{exact:true})).toBeVisible();
 const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'Export activity'}).click();const stream=await(await downloaded).createReadStream();let json='';for await(const chunk of stream)json+=String(chunk);expect(JSON.parse(json)).toMatchObject({payment:{state:'SETTLED',verificationReference:'synthetic-receipt-not-chain-evidence'}});
});
test('reviewer examples remain visibly synthetic and isolated',async({page})=>{
 await login(page,'/reviewer',true);await page.getByRole('button',{name:'Load reviewer examples',exact:true}).click();await page.getByRole('button',{name:'Evaluate refuse a duplicate',exact:true}).click();await expect(page.getByRole('region',{name:'Synthetic evaluation'})).toContainText('DUPLICATE_OR_SETTLED');await page.getByRole('button',{name:'Evaluate use a verified discount',exact:true}).click();await expect(page.getByRole('region',{name:'Synthetic evaluation'})).toContainText('0.900000 USDC');await expect(page.getByRole('button',{name:'Approve invoice',exact:true})).toHaveCount(0);
});


test('invoice review remains usable with unavailable secondary data and on mobile',async({page})=>{
 await login(page,'/dashboard/invoices/new');
 const {readFile}=await import('node:fs/promises');const png=await readFile('fixtures/synthetic-invoice.png');
 await page.getByLabel('Invoice image').setInputFiles({name:'review-layout.png',mimeType:'image/png',buffer:Buffer.concat([png,Buffer.from('review-layout-scenario')])});
 await page.getByRole('button',{name:'Save invoice',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Invoice evidence',exact:true})).toBeVisible();
 await expect(page.getByRole('heading',{name:'Verification results',exact:true})).toBeVisible();
 await expect(page.getByRole('heading',{name:'Approval scope',exact:true})).toBeVisible();
 await expect(page.getByText('This invoice and exact payment terms only',{exact:true})).toBeVisible();
 await page.route('**/api/invoices/*/audit',r=>r.abort());await page.route('**/api/treasury',r=>r.abort());await page.route('**/api/policy',r=>r.abort());
 await page.getByRole('button',{name:'Refresh invoice',exact:false}).click();
 await expect(page.getByRole('heading',{name:'Invoice evidence',exact:true})).toBeVisible();
 await expect(page.getByText('Activity unavailable. Refresh to retry; export is disabled.',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Export activity',exact:true})).toBeDisabled();
 await expect(page.getByText('Treasury information unavailable. Refresh to retry.',{exact:true})).toBeVisible();
 await page.setViewportSize({width:390,height:844});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.getByRole('link',{name:'Review, reject or re-evaluate ↓',exact:true}).click();
 await expect(page.getByLabel('Review reason',{exact:true})).toBeInViewport();
 await expect(page.getByRole('button',{name:'Save correction',exact:true})).toBeDisabled();
});

test('action center does not invent totals or selections when reports are unavailable',async({page})=>{
 await login(page,'/dashboard/actions');
 await expect(page.getByRole('heading',{name:'Action Center',exact:true})).toBeVisible();
 await expect(page.getByRole('heading',{name:'Filter invoices',exact:true})).toHaveCount(0);
 await expect(page.getByLabel('Search invoice or vendor',{exact:true})).toHaveCount(0);
 await expect(page.getByText('Queue totals unavailable. Refresh to retry.',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Awaiting approval queue',exact:true})).toContainText('Unavailable');
 await expect(page.getByRole('heading',{name:'Review guidance',exact:true})).toHaveCount(0);
 await page.setViewportSize({width:390,height:844});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});


test('action center prioritizes an unresolved payment over its older approval decision',async({page})=>{
 await login(page);
 const id='00000000-0000-4000-8000-000000000010';
 const invoice={id,status:'OPEN',version:1,invoiceNumber:'SYNTHETIC-UNRESOLVED',vendorName:'Synthetic test vendor',amountMicroUsdc:'100000',dueDate:'2026-10-16',createdAt:'2026-10-16T18:00:00.000Z',decision:'REQUIRE_APPROVAL',paymentState:'UNKNOWN'};
 const row={...invoice,reason:'SOFT_THRESHOLD',nextEvaluationAt:null};
 const headers={'access-control-allow-origin':'http://127.0.0.1:3100','access-control-allow-credentials':'true'};
 await page.route('**/api/workspace/summary',route=>route.fulfill({headers,json:{capturedAt:invoice.createdAt,counts:{total:1,processing:0,approvals:1,held:0,scheduled:0,rejected:0,settled:0},recentInvoices:[row],actionQueue:[row],recentActivity:[]}}));
 await page.route('**/api/workspace/invoices?*',route=>route.fulfill({headers,json:{invoices:[row],total:1,nextOffset:null}}));
 await page.route(`**/api/invoices/${id}`,route=>route.fulfill({headers,json:{invoice,facts:null,decision:{id,action:'REQUIRE_APPROVAL',reason:'SOFT_THRESHOLD',evidenceIds:[],evaluatedAt:invoice.createdAt},payment:{state:'UNKNOWN',providerId:null,providerState:null,transactionHash:null,settledAt:null,actualFeeMicroUsdc:null,verificationReference:null},processingMessage:'Isolated unresolved-payment test'}}));
 const financialWrites:string[]=[];page.on('request',request=>{if(request.method()==='POST'&&/approve|reject|evaluate|reconcile/.test(request.url()))financialWrites.push(request.url());});
 await page.goto('/dashboard/actions');
 const card=page.getByRole('region',{name:'Invoice payment actions',exact:true});
 await expect(card).toContainText('Your approval was recorded, but the payment outcome is unresolved.');
 for(const name of ['Approve exact terms','Reject','Re-evaluate'])await expect(card.getByRole('button',{name,exact:true})).toBeDisabled();
 await expect(page.locator('.ac-guidance')).toContainText('Payment unresolved');
 await expect(page.locator('.ac-guidance')).not.toContainText('Automatic approval threshold');
 await expect(card.getByRole('link',{name:'Open full invoice review →',exact:true})).toHaveAttribute('href',`/dashboard/invoices/${id}`);
 expect(financialWrites).toEqual([]);
});
