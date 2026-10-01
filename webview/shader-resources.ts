export function createShaderResources(
  gl: WebGLRenderingContext,
  vertex: string,
  fragment: string,
): { program: WebGLProgram; buffer: WebGLBuffer; dispose(): void } | null {
  const shaders: WebGLShader[] = [];
  let program: WebGLProgram | null = null;
  let buffer: WebGLBuffer | null = null;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (buffer) gl.deleteBuffer(buffer);
    if (program) gl.deleteProgram(program);
    for (const shader of shaders) gl.deleteShader(shader);
  };
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type);
    if (!shader) return null;
    shaders.push(shader);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
  };
  const vs = compile(gl.VERTEX_SHADER, vertex);
  const fs = compile(gl.FRAGMENT_SHADER, fragment);
  if (vs && fs) {
    program = gl.createProgram();
    if (program) {
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      if (gl.getProgramParameter(program, gl.LINK_STATUS)) buffer = gl.createBuffer();
    }
  }
  if (!program || !buffer) {
    dispose();
    return null;
  }
  return { program, buffer, dispose };
}
