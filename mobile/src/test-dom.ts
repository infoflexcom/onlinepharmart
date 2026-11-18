/**
 * A very small DOM, just enough for the screen builders.
 *
 * The phone screens are built with `document.createElement` and plain DOM calls, which is what keeps the
 * bundle small and lets the tests read the same tree the browser paints. Rather than pull in a full DOM
 * implementation (and a large dependency), this provides the handful of operations the builders use. It is
 * deliberately not a general-purpose DOM: anything a screen needs that is missing here should be added
 * explicitly, so the test stays honest about what the browser is being asked to do.
 */

interface TestNode {
  nodeType: number
  nodeName: string
  childNodes: TestNode[]
  parentNode: TestNode | null
  ownerDocument: TestDocument
}

export class TestElement extends EventTarget implements TestNode {
  readonly nodeType = 1
  readonly nodeName: string
  readonly ownerDocument: TestDocument
  childNodes: TestNode[] = []
  parentNode: TestNode | null = null
  className = ''
  id = ''
  hidden = false
  title = ''
  type = ''
  value = ''
  placeholder = ''
  inputMode = ''
  autocomplete = ''
  step = ''
  rel = ''
  href = ''
  download = ''
  muted = false
  style: Record<string, string> = {}
  private readonly attributes = new Map<string, string>()
  private ownText = ''

  constructor(tag: string, document: TestDocument) {
    super()
    this.nodeName = tag.toUpperCase()
    this.ownerDocument = document
  }

  get tagName(): string {
    return this.nodeName
  }

  /**
   * A real DOMTokenList, reduced to the operations the screens use. `className` and `classList` must stay in
   * step, because the builders use both (`el()` sets className, then a caller adds one more class).
   */
  readonly classList = {
    add: (...names: string[]): void => {
      const set = new Set(this.className.split(/\s+/u).filter(Boolean))
      for (const name of names) set.add(name)
      this.className = [...set].join(' ')
    },
    remove: (...names: string[]): void => {
      const set = new Set(this.className.split(/\s+/u).filter(Boolean))
      for (const name of names) set.delete(name)
      this.className = [...set].join(' ')
    },
    contains: (name: string): boolean => this.className.split(/\s+/u).includes(name),
    toggle: (name: string, force?: boolean): boolean => {
      const has = this.className.split(/\s+/u).includes(name)
      const next = force === undefined ? !has : force
      if (next && !has) this.classList.add(name)
      if (!next && has) this.classList.remove(name)
      return next
    },
  }

  get textContent(): string {
    const children = this.childNodes.map((child) => child instanceof TestElement ? child.textContent : '').join('')
    return this.ownText + children
  }

  set textContent(value: string) {
    this.childNodes = []
    this.ownText = value
  }

  get children(): TestElement[] {
    return this.childNodes.filter((child): child is TestElement => child instanceof TestElement)
  }

  append(...nodes: Array<TestElement | string>): void {
    for (const node of nodes) {
      if (typeof node === 'string') {
        this.ownText += node
        continue
      }
      node.parentNode = this
      this.childNodes.push(node)
    }
  }

  prepend(node: TestElement): void {
    node.parentNode = this
    this.childNodes.unshift(node)
  }

  replaceChildren(...nodes: TestElement[]): void {
    this.childNodes = []
    this.ownText = ''
    this.append(...nodes)
  }

  remove(): void {
    if (this.parentNode instanceof TestElement) {
      this.parentNode.childNodes = this.parentNode.childNodes.filter((child) => child !== this)
    }
    this.parentNode = null
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
    if (name === 'id') this.id = value
    if (name === 'class') this.className = value
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name)
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }

  focus(): void {
    this.ownerDocument.activeElement = this
  }

  click(): void {
    this.dispatchEvent(new Event('click'))
  }

  /** A deliberately simple selector: `#id`, `.class`, `tag` or `tag.class`. */
  querySelector<T extends TestElement = TestElement>(selector: string): T | null {
    for (const child of this.children) {
      if (matches(child, selector)) return child as T
      const nested = child.querySelector<T>(selector)
      if (nested) return nested
    }
    return null
  }

  querySelectorAll<T extends TestElement = TestElement>(selector: string): T[] {
    const found: T[] = []
    const walk = (node: TestElement): void => {
      for (const child of node.children) {
        if (matches(child, selector)) found.push(child as T)
        walk(child)
      }
    }
    walk(this)
    return found
  }
}

function matches(node: TestElement, selector: string): boolean {
  if (selector.startsWith('#')) return node.id === selector.slice(1)
  if (selector.startsWith('.')) return node.className.split(/\s+/u).includes(selector.slice(1))
  const [tag, className] = selector.split('.')
  if (tag && node.nodeName !== tag.toUpperCase()) return false
  if (className) return node.className.split(/\s+/u).includes(className)
  return true
}

export class TestDocument {
  activeElement: TestElement | null = null
  private readonly documentElement: TestElement

  constructor() {
    // A document needs a root for `body.append`, but the screens only ever touch `document.body`.
    this.documentElement = new TestElement('html', this)
    const body = new TestElement('body', this)
    this.documentElement.append(body)
  }

  get body(): TestElement {
    return this.documentElement.querySelector<TestElement>('body')!
  }

  createElement(tag: string): TestElement {
    return new TestElement(tag, this)
  }

  createElementNS(_namespace: string, tag: string): TestElement {
    return new TestElement(tag, this)
  }
}

export function installTestDom(): TestDocument {
  const document = new TestDocument()
  const globalScope = globalThis as unknown as { document?: unknown }
  globalScope.document = document
  return document
}

/** Every word rendered inside a node, with whitespace collapsed, for readable assertions. */
export function textOf(node: { textContent: string | null }): string {
  return (node.textContent ?? '').replace(/\s+/gu, ' ').trim()
}

/**
 * The builders are typed against the real DOM, so tests must be able to query them the same way. This cast
 * is the single seam between the shim and the browser types; nothing else in the tests pretends to be a DOM.
 */
export function asTestElement(node: unknown): TestElement {
  return node as TestElement
}
