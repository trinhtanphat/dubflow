import { isR2Mp4RemuxRuntimeReady } from './mp4-remux';

export async function checkRemuxRuntimeReady(): Promise<boolean> {
  return isR2Mp4RemuxRuntimeReady();
}
