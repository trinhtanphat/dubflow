import { describe, expect, it } from 'vitest';
import { checkReadiness } from '../src/routes/readiness';

describe('checkReadiness', () => {
  it('reports ready only after the projects schema exists', async () => {
    const db = {
      prepare() {
        return {
          async first<T>() {
            return { name: 'projects' } as T;
          },
        };
      },
    };

    await expect(checkReadiness(db)).resolves.toEqual({
      ready: true,
      service: 'dubflow',
      database: 'ready',
    });
  });

  it('fails closed before migrations create the projects table', async () => {
    const db = {
      prepare() {
        return {
          async first<T>() {
            return null as T | null;
          },
        };
      },
    };

    await expect(checkReadiness(db)).resolves.toEqual({
      ready: false,
      service: 'dubflow',
      database: 'missing-schema',
    });
  });

  it('fails closed when D1 is unavailable', async () => {
    const db = {
      prepare() {
        return {
          async first<T>() {
            throw new Error('D1 unavailable');
          },
        };
      },
    };

    await expect(checkReadiness(db)).resolves.toEqual({
      ready: false,
      service: 'dubflow',
      database: 'unavailable',
    });
  });
});
