# U3 — Custom shader background

## Goal
Let the user supply GLSL fragment code that becomes the animated-gradient background.

## Model
- New background mode `custom`; setting `customShader: string` (the fragment source).
- Shared `webview/shaderSource.ts`: `DEFAULT_CUSTOM` (an animated gradient template),
  the uniform contract, and `validateShader(source) -> { ok, log }` (compiles in a
  throwaway WebGL context for live feedback).
- Uniforms provided to the shader: `u_res` (vec2 px), `u_time` (float s),
  `u_c1/u_c2/u_c3` (vec3 theme colours), `u_alpha` (float intensity).

## ShaderBg
Accept an optional `source`; use it as the fragment shader (else the built-in
plasma). Same uniforms/loop/intensity/perf as T2. On compile failure → onUnsupported
(falls back to Flow); the editor surfaces the error so the user can fix it.

## AnimatedBg
- `shader` → ShaderBg (built-in plasma).
- `custom` → ShaderBg with `source = customShader || DEFAULT_CUSTOM`.

## Settings → Appearance
- Background segmented adds **Custom**.
- When `custom` is selected, show a **shader editor**: a textarea bound to
  `customShader` (debounced), prefilled with the template; **drag-drop** a
  `.glsl/.frag/.txt` file to load it; a "Reset to template" button; a live
  **compile status** line (✓ compiles / error log) via `validateShader`.

## Acceptance criteria
1. Selecting Custom uses the editor's shader as the animated background (verified GL).
2. Editing the shader updates the background; a valid animated gradient renders.
3. Dropping a .frag file loads its contents into the editor.
4. An invalid shader shows the compile error and the bg falls back gracefully.
5. customShader persists; typecheck + build + tests green.
