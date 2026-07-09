type ClassListLike = {
	add(...classes: string[]): void;
	remove(...classes: string[]): void;
	contains(className: string): boolean;
	toggle(className: string, force?: boolean): boolean;
};

type HeadlessElementInfo = string | {
	text?: string | DocumentFragment;
	cls?: string | string[];
	attr?: Record<string, string | number | boolean>;
	[key: string]: unknown;
};

export interface HeadlessElement {
	[key: string]: any;
	textContent: string;
	innerText: string;
	innerHTML: string;
	tagName: string;
	value: string;
	checked: boolean;
	disabled: boolean;
	style: Record<string, string>;
	dataset: Record<string, string>;
	children: HeadlessElement[];
	classList: ClassListLike;
	addClass(...classes: string[]): HeadlessElement;
	addClasses(classes: string[]): HeadlessElement;
	removeClass(...classes: string[]): HeadlessElement;
	removeClasses(classes: string[]): HeadlessElement;
	toggleClass(classes: string | string[], value: boolean): HeadlessElement;
	setText(text: string | DocumentFragment): HeadlessElement;
	setAttr(name: string, value: string | number | boolean): HeadlessElement;
	appendChild(child: HeadlessElement): HeadlessElement;
	createEl(tag: string, attrs?: HeadlessElementInfo, callback?: (el: HeadlessElement) => void): HeadlessElement;
	createDiv(attrs?: HeadlessElementInfo, callback?: (el: HeadlessElement) => void): HeadlessElement;
	createSpan(attrs?: HeadlessElementInfo, callback?: (el: HeadlessElement) => void): HeadlessElement;
	addEventListener(type: string, callback: (...args: any[]) => void): void;
	removeEventListener(type: string, callback: (...args: any[]) => void): void;
	dispatchEvent(event: { type?: string }): boolean;
	focus(): void;
	blur(): void;
	empty(): void;
	remove(): void;
}

export function createHeadlessElement(tag = "div"): HeadlessElement {
	const classes = new Set<string>();
	const attrs = new Map<string, string>();
	const listeners = new Map<string, Set<(...args: any[]) => void>>();
	const element: HeadlessElement = {
		textContent: "",
		innerText: "",
		innerHTML: "",
		tagName: tag.toUpperCase(),
		value: "",
		checked: false,
		disabled: false,
		style: {},
		dataset: {},
		children: [],
		classList: {
			add: (...names) => {
				for (const name of names) classes.add(name);
			},
			remove: (...names) => {
				for (const name of names) classes.delete(name);
			},
			contains: (name) => classes.has(name),
			toggle: (name, force) => {
				const next = force ?? !classes.has(name);
				if (next) classes.add(name);
				else classes.delete(name);
				return next;
			},
		},
		addClass(...names) {
			for (const name of names) classes.add(name);
			return this;
		},
		addClasses(names) {
			for (const name of names) classes.add(name);
			return this;
		},
		removeClass(...names) {
			for (const name of names) classes.delete(name);
			return this;
		},
		removeClasses(names) {
			for (const name of names) classes.delete(name);
			return this;
		},
		toggleClass(names, value) {
			const list = Array.isArray(names) ? names : [names];
			for (const name of list) {
				if (value) classes.add(name);
				else classes.delete(name);
			}
			return this;
		},
		setText(text) {
			const next = String(text);
			this.textContent = next;
			this.innerText = next;
			return this;
		},
		setAttr(name, value) {
			attrs.set(name, String(value));
			if (name === "value") this.value = String(value);
			if (name === "checked") this.checked = Boolean(value);
			if (name === "disabled") this.disabled = Boolean(value);
			if (name.startsWith("data-")) this.dataset[toDatasetKey(name)] = String(value);
			return this;
		},
		appendChild(child) {
			this.children.push(child);
			return child;
		},
		createEl(childTag, childAttrs, callback) {
			const child = createHeadlessElement(childTag);
			applyElementInfo(child, childAttrs);
			this.children.push(child);
			callback?.(child);
			return child;
		},
		createDiv(childAttrs, callback) {
			return this.createEl("div", childAttrs, callback);
		},
		createSpan(childAttrs, callback) {
			return this.createEl("span", childAttrs, callback);
		},
		addEventListener(type, callback) {
			let set = listeners.get(type);
			if (!set) {
				set = new Set();
				listeners.set(type, set);
			}
			set.add(callback);
		},
		removeEventListener(type, callback) {
			listeners.get(type)?.delete(callback);
		},
		dispatchEvent(event) {
			const type = event.type;
			if (!type) return true;
			for (const listener of Array.from(listeners.get(type) ?? [])) listener(event);
			return true;
		},
		focus() {},
		blur() {},
		empty() {
			this.children = [];
			this.textContent = "";
			this.innerText = "";
			this.innerHTML = "";
		},
		remove() {
			this.empty();
		},
	};
	element.setAttr("data-headless-tag", tag);
	return element;
}

function applyElementInfo(element: HeadlessElement, info?: HeadlessElementInfo): void {
	if (!info) return;
	if (typeof info === "string") {
		element.addClass(info);
		return;
	}
	for (const [key, value] of Object.entries(info)) {
		if (value === undefined || value === null) continue;
		if (key === "text") element.setText(value as string | DocumentFragment);
		else if (key === "cls") {
			const classes = Array.isArray(value) ? value : String(value).split(/\s+/);
			element.addClasses(classes.filter(Boolean).map(String));
		} else if (key === "attr" && typeof value === "object" && value !== null) {
			for (const [attrName, attrValue] of Object.entries(value as Record<string, string | number | boolean>)) {
				element.setAttr(attrName, attrValue);
			}
		} else {
			element.setAttr(key, value as string | number | boolean);
		}
	}
}

function toDatasetKey(attr: string): string {
	return attr.slice("data-".length).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}
