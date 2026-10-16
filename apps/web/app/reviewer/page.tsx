"use client";
import {ReviewerExamples} from "../dashboard/ReviewerExamples";
import {useWorkspace} from "../dashboard/WorkspaceProvider";
export default function Page(){const {api,busy,action}=useWorkspace();return <section className="ap-panel"><h1>Isolated reviewer examples</h1><p>Clearly labeled synthetic scenarios. These never read private business records or send payments.</p><ReviewerExamples api={api} busy={busy} action={action}/></section>;}
