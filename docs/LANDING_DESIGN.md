# Conclave landing page art direction

The public page pairs original editorial photography with a purple-led brand
identity and illustrative product scenes. Photos support the two main contexts:
close personal conversations and collaborative plans. They are generated artwork,
not customer photographs or endorsements.

The shared light/dark palette and existing purple brand values are retained.
Public-page layout styles live in `client/src/styles/landing.css` and are scoped
to `.cl-landing`. The page no longer uses the old grid/marquee visual treatment.
The product section has keyboard-accessible tabs for conversations, decisions
and tasks; its example data is explicitly labelled as an illustration.

## Images

Generated with the built-in image generation tool, then encoded into responsive
WebP files. No external photo host or runtime image service is required.

- `client/src/assets/landing/conclave-studio-v2-1536.webp`
- `client/src/assets/landing/conclave-studio-v2-768.webp`
- `client/src/assets/landing/conclave-coast-v2-1536.webp`
- `client/src/assets/landing/conclave-coast-v2-768.webp`

Hero imagery loads with high priority; supporting photos use lazy loading and
responsive sources. Images have intrinsic dimensions to reserve their space.
Large sources are approximately 223–234 KiB; smaller variants are about 85 KiB.

### Studio prompt

Use case: photorealistic-natural. Asset type: premium lifestyle photography for Conclave, a purple-brand messaging and collaboration product landing page. Create a beautifully art-directed candid editorial photograph, landscape 3:2. Four diverse young adult friends and creative collaborators around a rounded walnut table in a sunlit contemporary creative studio, natural laughter and a real relaxed shared moment, one person showing an idea in a notebook, a discreet laptop, coffee, leafy greenery, expansive tall windows. Tasteful purple/lilac accents in a knit top and small objects, creamy plaster walls, deep green plant tones, natural oak. People look like interesting creatives, not corporate stock models. Cinematic warm late-afternoon light, subtle film grain, realistic skin and hands, premium magazine photography with authentic imperfections, excellent composition and depth, photographed with 35mm lens. Frame people centrally with all faces comfortably away from edges so a square/portrait crop works. No lettering, no typography, no logo, no watermark, no interface, no fake screenshots. Final image is a real editorial scene, not a webpage mockup. Save the generated file and return its local filesystem path for integration into the project.

### Coastal prompt

Use case: photorealistic-natural. Asset type: premium editorial lifestyle image for Conclave messaging product website, showing connection outside work. Create a cinematic candid landscape 3:2 photograph of three diverse adult friends in their late twenties laughing together at a relaxed seaside picnic on a grassy coastal overlook. One person with curly dark hair in lavender knit, another in muted blue, another in natural cream. A soft burnt-orange picnic blanket, small picnic fruit and a vintage camera, turquoise ocean in background, golden sunset with gentle ocean breeze. Authentic, intimate, aspirational but natural, premium travel magazine art direction, subtle film grain, beautiful composition, realistic hands and skin. Fill frame with friends and landscape, faces comfortably inside frame to allow square crop. No computers, no text, no typography, no interface, no watermarks, no brand logos, no exaggerated stock-photo poses. This is an editorial photograph for a website asset, not a website mockup. Save final image and return its filesystem path for project integration.

## Motion

GSAP and ScrollTrigger load with the lazy landing route. Motion is owned by
`client/src/hooks/useLandingMotion.js`; the product illustration separately owns
its tab transitions. Headline lines arrive in sequence, photo overlays settle
into place, sections reveal on scroll, and desktop decorative accents track
scroll or pointer entry. There are no pinned sections, scroll interception or
continuous animation loops.

Mobile uses shorter entrance movement and omits scroll-linked decoration.
`prefers-reduced-motion` is observed live through `gsap.matchMedia()`: changing
it restores the static page, including any in-progress tab animations. Contexts
and listeners are reverted on unmount, so navigating between public/auth routes
does not retain old ScrollTriggers. Text remains in the DOM and visible without
animation initialization.

Implementation references: [GSAP matchMedia](https://gsap.com/docs/v3/GSAP/gsap.matchMedia())
and [ScrollTrigger](https://gsap.com/docs/v3/Plugins/ScrollTrigger/).
