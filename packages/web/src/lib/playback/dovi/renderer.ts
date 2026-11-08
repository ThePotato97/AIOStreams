/*
 * Draws Dolby Vision video frames on an HDR canvas with WebGPU: each frame's decoded planes
 * (VideoFrame.copyTo: the browser's own conversion to RGB would drop the RPU's reshaping) through
 * shader.ts, onto an rgba16float canvas in extended-range Display P3.
 */
import { packParams, PARAM_FLOATS } from './math';
import type { DoviParams } from './rpu';
import { DOVI_SHADER } from './shader';

const align = (n: number) => Math.ceil(n / 256) * 256;

export class DoviRenderer {
  private textures: GPUTexture[] = [];
  private bind: GPUBindGroup | null = null;
  private size = '';
  private buffer = new Uint8Array(0);
  private params = new Float32Array(PARAM_FLOATS);
  private readonly paramBuf: GPUBuffer;
  private readonly viewBuf: GPUBuffer;
  private readonly layoutBuf: GPUBuffer;
  private readonly pipeline: GPURenderPipeline;

  private constructor(
    private readonly device: GPUDevice,
    private readonly context: GPUCanvasContext,
    private readonly canvas: HTMLCanvasElement
  ) {
    const module = device.createShaderModule({ code: DOVI_SHADER });
    this.pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: {
        module,
        entryPoint: 'fs',
        targets: [{ format: 'rgba16float' }],
      },
      primitive: { topology: 'triangle-list' },
    });
    this.paramBuf = device.createBuffer({
      size: PARAM_FLOATS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.viewBuf = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.layoutBuf = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  /** A renderer for the canvas, or null where WebGPU or an HDR canvas isn't available. */
  static async create(canvas: HTMLCanvasElement): Promise<DoviRenderer | null> {
    const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
    if (!gpu) return null;
    const adapter = await gpu.requestAdapter().catch(() => null);
    const device = await adapter?.requestDevice().catch(() => null);
    const context = canvas.getContext('webgpu');
    if (!device || !context) return null;
    try {
      context.configure({
        device,
        format: 'rgba16float',
        colorSpace: 'display-p3',
        toneMapping: { mode: 'extended' },
        alphaMode: 'opaque',
      });
    } catch {
      return null;
    }
    // Without extended tone mapping the canvas clamps to SDR: no better than the video.
    const config = context.getConfiguration?.() as
      (GPUCanvasConfiguration & { toneMapping?: { mode?: string } }) | null;
    if (config && config.toneMapping?.mode !== 'extended') return null;
    return new DoviRenderer(device, context, canvas);
  }

  private textureFor(w: number, h: number, format: GPUTextureFormat) {
    return this.device.createTexture({
      size: [w, h],
      format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
  }

  /** Draws one frame with its RPU's parameters (null: plain HDR10). */
  async draw(frame: VideoFrame, params: DoviParams | null) {
    // TypeScript's VideoPixelFormat predates the 10-bit formats
    const format = frame.format as string | null;
    const p010 = format === 'P010';
    if (!p010 && format !== 'I420P10')
      throw new Error(`Unsupported frame format ${format}`);
    const w = frame.visibleRect?.width ?? frame.codedWidth;
    const h = frame.visibleRect?.height ?? frame.codedHeight;
    const cw = Math.ceil(w / 2),
      ch = Math.ceil(h / 2);
    const layout = p010
      ? [
          { offset: 0, stride: align(w * 2) },
          { offset: align(w * 2) * h, stride: align(cw * 4) },
        ]
      : [
          { offset: 0, stride: align(w * 2) },
          { offset: align(w * 2) * h, stride: align(cw * 2) },
          {
            offset: align(w * 2) * h + align(cw * 2) * ch,
            stride: align(cw * 2),
          },
        ];
    const last = layout[layout.length - 1];
    const bytes = last.offset + last.stride * ch;
    if (this.buffer.length < bytes) this.buffer = new Uint8Array(bytes);
    await frame.copyTo(this.buffer, {
      layout,
      rect: { x: 0, y: 0, width: w, height: h },
    });

    const key = `${w}x${h}:${p010}`;
    if (key !== this.size) {
      this.size = key;
      for (const t of this.textures) t.destroy();
      this.textures = p010
        ? [
            this.textureFor(w, h, 'r16uint'),
            this.textureFor(cw, ch, 'rg16uint'),
            this.textureFor(1, 1, 'r16uint'),
          ]
        : [
            this.textureFor(w, h, 'r16uint'),
            this.textureFor(cw, ch, 'r16uint'),
            this.textureFor(cw, ch, 'r16uint'),
          ];
      this.bind = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          ...this.textures.map((t, i) => ({
            binding: i,
            resource: t.createView(),
          })),
          { binding: 3, resource: { buffer: this.paramBuf } },
          { binding: 4, resource: { buffer: this.viewBuf } },
          { binding: 5, resource: { buffer: this.layoutBuf } },
        ],
      });
      this.device.queue.writeBuffer(
        this.layoutBuf,
        0,
        new Uint32Array([p010 ? 1 : 0, 0, 0, 0])
      );
    }
    const q = this.device.queue;
    const planes = p010 ? 2 : 3;
    for (let i = 0; i < planes; i++)
      q.writeTexture(
        { texture: this.textures[i] },
        this.buffer,
        { offset: layout[i].offset, bytesPerRow: layout[i].stride },
        i === 0 ? [w, h] : [cw, ch]
      );
    q.writeBuffer(this.paramBuf, 0, packParams(params, this.params));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    q.writeBuffer(
      this.viewBuf,
      0,
      new Float32Array([w, h, this.canvas.width, this.canvas.height])
    );
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bind!);
    pass.draw(3);
    pass.end();
    q.submit([enc.finish()]);
  }

  destroy() {
    for (const t of this.textures) t.destroy();
    this.paramBuf.destroy();
    this.viewBuf.destroy();
    this.layoutBuf.destroy();
    this.context.unconfigure();
    this.device.destroy();
  }
}
