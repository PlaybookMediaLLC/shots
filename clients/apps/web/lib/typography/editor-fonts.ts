import {
  Albert_Sans,
  Bebas_Neue,
  Caveat,
  DM_Sans,
  Dancing_Script,
  Fira_Code,
  Lexend,
  Libre_Baskerville,
  Lora,
  Manrope,
  Montserrat,
  Oswald,
  Outfit,
  Pacifico,
  Playfair_Display,
  Plus_Jakarta_Sans,
  Poppins,
  Raleway,
  Righteous,
  Sora,
  Space_Grotesk,
  Urbanist,
  Work_Sans,
} from 'next/font/google'

const poppins = Poppins({
  variable: '--font-poppins',
  preload: false,
  subsets: ['latin'],
  weight: ['100', '200', '300', '400', '500', '600', '700', '800', '900'],
})

const spaceGrotesk = Space_Grotesk({
  variable: '--font-space-grotesk',
  preload: false,
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700'],
})

const outfit = Outfit({
  variable: '--font-outfit',
  preload: false,
  subsets: ['latin'],
  weight: ['100', '200', '300', '400', '500', '600', '700', '800', '900'],
})

const plusJakartaSans = Plus_Jakarta_Sans({
  variable: '--font-plus-jakarta-sans',
  preload: false,
  subsets: ['latin'],
  weight: ['200', '300', '400', '500', '600', '700', '800'],
})

const dmSans = DM_Sans({
  variable: '--font-dm-sans',
  preload: false,
  subsets: ['latin'],
  weight: 'variable',
})

const sora = Sora({
  variable: '--font-sora',
  preload: false,
  subsets: ['latin'],
  weight: ['100', '200', '300', '400', '500', '600', '700', '800'],
})

const manrope = Manrope({
  variable: '--font-manrope',
  preload: false,
  subsets: ['latin'],
  weight: ['200', '300', '400', '500', '600', '700', '800'],
})

const raleway = Raleway({
  variable: '--font-raleway',
  preload: false,
  subsets: ['latin'],
  weight: ['100', '200', '300', '400', '500', '600', '700', '800', '900'],
})

const montserrat = Montserrat({
  variable: '--font-montserrat',
  preload: false,
  subsets: ['latin'],
  weight: ['100', '200', '300', '400', '500', '600', '700', '800', '900'],
})

const lexend = Lexend({
  variable: '--font-lexend',
  preload: false,
  subsets: ['latin'],
  weight: ['100', '200', '300', '400', '500', '600', '700', '800', '900'],
})

const workSans = Work_Sans({
  variable: '--font-work-sans',
  preload: false,
  subsets: ['latin'],
  weight: ['100', '200', '300', '400', '500', '600', '700', '800', '900'],
})

const urbanist = Urbanist({
  variable: '--font-urbanist',
  preload: false,
  subsets: ['latin'],
  weight: ['100', '200', '300', '400', '500', '600', '700', '800', '900'],
})

const albertSans = Albert_Sans({
  variable: '--font-albert-sans',
  preload: false,
  subsets: ['latin'],
  weight: ['100', '200', '300', '400', '500', '600', '700', '800', '900'],
})

const oswald = Oswald({
  variable: '--font-oswald',
  preload: false,
  subsets: ['latin'],
  weight: ['200', '300', '400', '500', '600', '700'],
})

const bebasNeue = Bebas_Neue({
  variable: '--font-bebas-neue',
  preload: false,
  subsets: ['latin'],
  weight: ['400'],
})

const righteous = Righteous({
  variable: '--font-righteous',
  preload: false,
  subsets: ['latin'],
  weight: ['400'],
})

const playfairDisplay = Playfair_Display({
  variable: '--font-playfair-display',
  preload: false,
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800', '900'],
})

const lora = Lora({
  variable: '--font-lora',
  preload: false,
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
})

const libreBaskerville = Libre_Baskerville({
  variable: '--font-libre-baskerville',
  preload: false,
  subsets: ['latin'],
  weight: ['400', '700'],
})

const caveat = Caveat({
  variable: '--font-caveat',
  preload: false,
  subsets: ['latin'],
})

const pacifico = Pacifico({
  variable: '--font-pacifico',
  preload: false,
  subsets: ['latin'],
  weight: ['400'],
})

const dancingScript = Dancing_Script({
  variable: '--font-dancing-script',
  preload: false,
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
})

const firaCode = Fira_Code({
  variable: '--font-fira-code',
  preload: false,
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700'],
})

/** CSS variable classes for the 23 decorative/canvas Google Fonts, scoped to editor & render layouts. */
export const editorFontVariables = [
  poppins.variable,
  spaceGrotesk.variable,
  outfit.variable,
  plusJakartaSans.variable,
  dmSans.variable,
  sora.variable,
  manrope.variable,
  raleway.variable,
  montserrat.variable,
  lexend.variable,
  workSans.variable,
  urbanist.variable,
  albertSans.variable,
  oswald.variable,
  bebasNeue.variable,
  righteous.variable,
  playfairDisplay.variable,
  lora.variable,
  libreBaskerville.variable,
  caveat.variable,
  pacifico.variable,
  dancingScript.variable,
  firaCode.variable,
].join(' ')
