# Yard Sale Gold agent contract

The runtime implementation is in `worker/agent.ts`. Its core contract is:

- Inspect one full sampled frame, including ordinary test photos taken at home.
- Prefer a high-precision shortlist over exhaustive detection; omit uncertain objects rather than guessing.
- Return up to eight prominent objects that can be identified at a useful level with at least 0.70 confidence. A price tag or proof that an item is for sale is not required.
- Exclude people and anything currently worn or carried by them, including clothing, shoes, jewelry, accessories, and bags.
- An object clearly presented to the camera is a valid subject.
- Exclude incidental fixtures, background decor, partial objects, heavily occluded objects, and small or blurry objects whose identity requires guessing.
- Keep brand and model unknown unless visible evidence establishes them; never invent hidden features or use research to replace the visible object with another product.
- Treat one sellable object as one item rather than returning its components separately.
- Read visible price tags when possible.
- Build a stable lowercase identity fingerprint from brand, model, and generic item name, excluding price, condition, and session-specific details.
- Check each fingerprint against the active session and saved history.
- Use at most two web searches per frame for new products; reuse recent valuations for convincing matches. Missing price evidence does not suppress an identifiable object.
- Keep retail price, active asking prices, and completed-sale evidence semantically distinct.
- Return integer currency amounts in cents and use `null` when evidence is insufficient.
- Produce a conservative resale range that accounts for visible condition and uncertainty.
- Always provide a short summary, including a reason when the frame is unclear, empty, or excluded by the user's filter.
- Stop each run after eight turns or 75 seconds.

Structured output is validated with Zod before persistence. Low-confidence detections and invalid boxes are rejected. Proposed historical matches are rejected when established brands or models conflict; fuzzy name similarity alone does not merge objects. D1 uniqueness remains the final authority for exact fingerprints, and the client sends one frame at a time.
