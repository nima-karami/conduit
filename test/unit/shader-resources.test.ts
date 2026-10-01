import { expect, it, vi } from 'vitest';
import { createShaderResources } from '../../webview/shader-resources';

function context(compileOk = true, linkOk = true) {
  let id = 0;
  return {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    createShader: vi.fn(() => ({ id: ++id })),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => compileOk),
    deleteShader: vi.fn(),
    createProgram: vi.fn(() => ({ id: ++id })),
    attachShader: vi.fn(),
    linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => linkOk),
    deleteProgram: vi.fn(),
    createBuffer: vi.fn(() => ({ id: ++id })),
    deleteBuffer: vi.fn(),
  };
}

it('releases the entire pipeline on cleanup and makes cleanup idempotent', () => {
  const gl = context();
  const resources = createShaderResources(
    gl as unknown as WebGLRenderingContext,
    'vertex',
    'fragment',
  );
  expect(resources).not.toBeNull();
  resources?.dispose();
  resources?.dispose();
  expect(gl.deleteShader).toHaveBeenCalledTimes(2);
  expect(gl.deleteProgram).toHaveBeenCalledTimes(1);
  expect(gl.deleteBuffer).toHaveBeenCalledTimes(1);
});

it.each([
  [false, true],
  [true, false],
])('releases partial allocations on failure (%s, %s)', (compileOk, linkOk) => {
  const gl = context(compileOk, linkOk);
  expect(
    createShaderResources(gl as unknown as WebGLRenderingContext, 'vertex', 'fragment'),
  ).toBeNull();
  expect(gl.deleteShader.mock.calls.length).toBe(gl.createShader.mock.calls.length);
  expect(gl.deleteProgram.mock.calls.length).toBe(gl.createProgram.mock.calls.length);
  expect(gl.deleteBuffer.mock.calls.length).toBe(gl.createBuffer.mock.calls.length);
});
