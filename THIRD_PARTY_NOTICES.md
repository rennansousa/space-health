# Third-party materials and licenses

Space Apps rule (Participant Terms, "Use of Third-Party Materials"): third-party materials in a
solution must be freely and publicly available without restriction, or licensed as open source
(OSI); their licenses must be listed in the documentation; every source must be cited. This file
is that list. Space Health's own code is licensed under Apache-2.0 (see `LICENSE`).

## Data

| Material | License / status | Use |
|---|---|---|
| NASA OSDR OSD-575, Inspiration4 comprehensive metabolic panel (`backend/data/osd_575_real_astronaut_blood.csv`) | NASA open data, public | Real blood chemistry of crew C001–C004 |
| HuBMAP CCF 3D Reference Object Library v1.2 (male skin, heart, lungs, kidneys, liver, spinal cord), simplified and compressed into `app/public/models/body.glb` | CC BY 4.0, https://humanatlas.io | 3D body on the crew screen; attribution shown on screen ("3D: HuBMAP CCF Reference Organs · CC BY 4.0") |

## Fonts

| Material | License | Use |
|---|---|---|
| Sora (Jonathan Barnbrook, Julián Moncada), `app/public/fonts/` | SIL Open Font License 1.1 | Interface typeface, bundled for offline use |

## Software in the solution

| Component | Version | License | Use |
|---|---|---|---|
| Python standard library | 3.10+ | PSF License (OSI) | Backend |
| React, react-dom | 18.3 | MIT | App |
| three.js | 0.169 | MIT | 3D body |
| @react-three/fiber, @react-three/drei | 8.17, 9.117 | MIT | 3D body in React |
| Vite, @vitejs/plugin-react | 5.4, 4.3 | MIT | Build and dev server |
| vite-plugin-pwa (Workbox) | 0.20 | MIT | Offline install (PWA) |
| Capacitor (core, CLI, Android, iOS) | 6.1 | MIT | Android and iOS builds |
| TypeScript | 5.x | Apache-2.0 | Type checking |

## Optional local models (not shipped in the repository; the app works without them)

| Component | License | Use |
|---|---|---|
| Ollama runtime | MIT | Runs a local language model |
| Qwen3 (0.6B, 1.7B or 4B, Alibaba Qwen team) | Apache-2.0 | Fallback router (`needle,ollama`), maps words to protocol ids |
| Cactus Needle (`cactus-needle` package) | code Apache-2.0, weights MIT | First router, maps words to protocol ids |

Not used in the solution, because their licenses add use restrictions and are not OSI open
source: Meta Llama (Llama Community License) and Google MedGemma (Health AI Developer
Foundations terms). A team member may try them locally; the submitted solution and demo do not
depend on them.

## Guidance sources (content paraphrased, each entry cites its source)

CDC (hypoglycemia 15-15 rule), MedlinePlus, University Hospitals of North Midlands, Altru Health,
NCI Biospecimen Research Database, NASA Technical Reports Server (20040089364, 20160012725,
20150019624, 20150001655, 20220000516), NASA OCHMO Technical Brief OCHMO-TB-004, NASA Human
Health and Performance risk page (SANS), Royal College of Physicians NEWS2 charts, Labcorp SI
Unit Conversion Table. Exact URLs are in `backend/knowledge_base.json`,
`backend/knowledge/space_protocols.json` and `backend/switch_config.json`.

## AI-assisted development

AI coding assistants (including Claude by Anthropic) generated and edited parts of the code and
documentation; the team reviewed and tested them. This is disclosed in the submission form.
