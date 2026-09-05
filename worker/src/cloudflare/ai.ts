export type AiRunOptions = {
  returnRawResponse?: boolean;
};

export interface AiBinding {
  run(model: string, input: unknown, options?: AiRunOptions): Promise<unknown>;
}
