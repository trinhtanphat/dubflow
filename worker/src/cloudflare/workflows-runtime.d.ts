declare module 'cloudflare:workers' {
  export type WorkflowEvent<Params = unknown> = {
    payload: Params;
    instanceId: string;
    timestamp?: Date;
  };

  export interface WorkflowStep {
    do<T>(name: string, callback: () => Promise<T>): Promise<T>;
  }

  export class WorkflowEntrypoint<Env = unknown, Params = unknown> {
    protected env: Env;
    run(event: WorkflowEvent<Params>, step: WorkflowStep): Promise<unknown>;
  }
}
