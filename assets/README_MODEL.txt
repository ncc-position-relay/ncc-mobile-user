Stage107 mobile 3D model location
=================================

Optional hosted model:
  assets/ncc_building.glb

The Web App also lets the operator choose a .glb/.gltf directly from phone storage,
so a model does NOT have to be committed to GitHub Pages for the first test.

For an online hosted model, use the same georeferenced building GLB whose local X/Z
coordinate system matches the NCC backend transform:
  A  = 1.001291223339
  B  = -0.053002028959
  TE = 530195.239973
  TN = 3950441.563611

Recommended mobile model size: <= 50 MB.
GitHub rejects regular files above 100 MB. A very large city GLB should NOT be placed
in this mobile package. Use a simplified single-building GLB for indoor testing.
