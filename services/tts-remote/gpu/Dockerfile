# 모시 TTS engine on the GPU box: vLLM-Omni 0.32.0 (Fish Audio Drama-3) on top of the stock vLLM 0.32.0 image.
# The base image (33 GB, torch 2.13 cu130 with sm_120 kernels) is already on the box, so this adds one small layer.
# torch / vllm / triton / transformers stay exactly as shipped: the constraints stop pip from swapping them.
# diffusers 0.40 (pulled in for vLLM-Omni's diffusion models, unused by TTS) caps huggingface-hub below 2.0, while the
# image's transformers 5.19 runs on hub 2.2; the override keeps the image's hub.
FROM vllm/vllm-openai:v0.32.0
RUN pip freeze | grep -iE '^(torch|torchvision|torchaudio|triton|numpy|transformers|flashinfer[-a-z0-9_]*|xformers)==' > /tmp/pins.txt \
 && echo "vllm==0.32.0" >> /tmp/pins.txt \
 && { cat /etc/uv-overrides.txt; pip freeze | grep -iE '^huggingface[-_]hub=='; } > /tmp/overrides.txt \
 && cat /tmp/pins.txt /tmp/overrides.txt \
 && uv pip install --system --no-cache -c /tmp/pins.txt --override /tmp/overrides.txt "vllm-omni==0.32.0" \
 && rm -f /tmp/pins.txt /tmp/overrides.txt \
 && python3 -c "import vllm_omni, vllm, torch; print('vllm-omni', vllm_omni.__version__, 'vllm', vllm.__version__, 'torch', torch.__version__)"
ENTRYPOINT []
