/*
 * The parts of WebGPU the Dolby Vision renderer uses (no @webgpu/types here: the workspace's
 * lockfile can't take a new package in this build). As the WebGPU spec defines them.
 */
type GPUTextureFormat =
  'r16uint' | 'rg16uint' | 'rgba16float' | 'bgra8unorm' | 'rgba8unorm';
type GPUBufferSource = ArrayBuffer | ArrayBufferView;

interface GPU {
  requestAdapter(): Promise<GPUAdapter | null>;
}
interface GPUAdapter {
  requestDevice(): Promise<GPUDevice>;
}
interface GPUBuffer {
  destroy(): void;
}
interface GPUTextureView {
  readonly __brand?: 'GPUTextureView';
}
interface GPUTexture {
  createView(): GPUTextureView;
  destroy(): void;
}
interface GPUBindGroupLayout {
  readonly __brand?: 'GPUBindGroupLayout';
}
interface GPUBindGroup {
  readonly __brand?: 'GPUBindGroup';
}
interface GPUShaderModule {
  readonly __brand?: 'GPUShaderModule';
}
interface GPURenderPipeline {
  getBindGroupLayout(index: number): GPUBindGroupLayout;
}
interface GPUCommandBuffer {
  readonly __brand?: 'GPUCommandBuffer';
}
interface GPURenderPassEncoder {
  setPipeline(pipeline: GPURenderPipeline): void;
  setBindGroup(index: number, group: GPUBindGroup): void;
  draw(vertices: number): void;
  end(): void;
}
interface GPUCommandEncoder {
  beginRenderPass(descriptor: {
    colorAttachments: {
      view: GPUTextureView;
      loadOp: 'clear' | 'load';
      storeOp: 'store' | 'discard';
      clearValue?: { r: number; g: number; b: number; a: number };
    }[];
  }): GPURenderPassEncoder;
  finish(): GPUCommandBuffer;
}
interface GPUQueue {
  writeBuffer(buffer: GPUBuffer, offset: number, data: GPUBufferSource): void;
  writeTexture(
    destination: { texture: GPUTexture },
    data: GPUBufferSource,
    layout: { offset?: number; bytesPerRow?: number },
    size: [number, number]
  ): void;
  submit(buffers: GPUCommandBuffer[]): void;
}
interface GPUDevice {
  readonly queue: GPUQueue;
  createShaderModule(descriptor: { code: string }): GPUShaderModule;
  createRenderPipeline(descriptor: {
    layout: 'auto';
    vertex: { module: GPUShaderModule; entryPoint: string };
    fragment: {
      module: GPUShaderModule;
      entryPoint: string;
      targets: { format: GPUTextureFormat }[];
    };
    primitive?: { topology: 'triangle-list' };
  }): GPURenderPipeline;
  createBuffer(descriptor: { size: number; usage: number }): GPUBuffer;
  createTexture(descriptor: {
    size: [number, number];
    format: GPUTextureFormat;
    usage: number;
  }): GPUTexture;
  createBindGroup(descriptor: {
    layout: GPUBindGroupLayout;
    entries: {
      binding: number;
      resource: GPUTextureView | { buffer: GPUBuffer };
    }[];
  }): GPUBindGroup;
  createCommandEncoder(): GPUCommandEncoder;
  destroy(): void;
}
interface GPUCanvasConfiguration {
  device: GPUDevice;
  format: GPUTextureFormat;
  colorSpace?: 'srgb' | 'display-p3';
  toneMapping?: { mode: 'standard' | 'extended' };
  alphaMode?: 'opaque' | 'premultiplied';
}
interface GPUCanvasContext {
  configure(configuration: GPUCanvasConfiguration): void;
  unconfigure(): void;
  getConfiguration?(): GPUCanvasConfiguration | null;
  getCurrentTexture(): GPUTexture;
}
interface HTMLCanvasElement {
  getContext(contextId: 'webgpu'): GPUCanvasContext | null;
}
declare const GPUBufferUsage: {
  readonly STORAGE: number;
  readonly UNIFORM: number;
  readonly COPY_DST: number;
  readonly COPY_SRC: number;
  readonly MAP_READ: number;
};
declare const GPUTextureUsage: {
  readonly TEXTURE_BINDING: number;
  readonly COPY_DST: number;
  readonly RENDER_ATTACHMENT: number;
};
