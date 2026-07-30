import ts from "typescript";

function nodeName(node, sourceFile) {
	if (!node?.name) return null;
	if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) || ts.isNumericLiteral(node.name)) {
		return node.name.text;
	}
	return node.name.getText(sourceFile);
}

function unwrapTransparentExpression(node) {
	let current = node;
	while (
		current
		&& (
			ts.isParenthesizedExpression(current)
			|| ts.isAsExpression(current)
			|| ts.isTypeAssertionExpression(current)
			|| ts.isNonNullExpression(current)
			|| ts.isSatisfiesExpression(current)
		)
	) {
		current = current.expression;
	}
	return current;
}

function lexicalScopeFor(node) {
	let current = node.parent;
	while (current) {
		if (
			ts.isBlock(current)
			|| ts.isSourceFile(current)
			|| ts.isModuleBlock(current)
			|| ts.isCaseBlock(current)
			|| ts.isCatchClause(current)
			|| ts.isForStatement(current)
			|| ts.isForInStatement(current)
			|| ts.isForOfStatement(current)
			|| ts.isFunctionLike(current)
		) return current;
		current = current.parent;
	}
	return null;
}

function functionOrSourceScopeFor(node) {
	let current = node.parent;
	while (current) {
		if (
			ts.isFunctionLike(current)
			|| ts.isSourceFile(current)
			|| ts.isModuleBlock(current)
			|| ts.isClassStaticBlockDeclaration(current)
		) return current;
		current = current.parent;
	}
	return null;
}

function isDescendantOf(node, ancestor) {
	let current = node;
	while (current) {
		if (current === ancestor) return true;
		current = current.parent;
	}
	return false;
}

function nodeDepth(node) {
	let depth = 0;
	let current = node;
	while (current?.parent) {
		depth++;
		current = current.parent;
	}
	return depth;
}

function collectLexicalBindings(sourceFile) {
	const byName = new Map();

	function add(name, binding) {
		const entries = byName.get(name) ?? [];
		entries.push(binding);
		byName.set(name, entries);
	}

	function addBindingPattern(name, binding) {
		if (ts.isIdentifier(name)) {
			add(name.text, binding);
			return;
		}
		for (const element of name.elements) {
			if (!ts.isBindingElement(element)) continue;
			addBindingPattern(element.name, {
				...binding,
				node: element,
				isConst: false,
				initializer: null,
			});
		}
	}

	function addBlockingDeclaration(name, node, scope = lexicalScopeFor(node)) {
		if (!name || !scope) return;
		addBindingPattern(name, {
			node,
			scope,
			isConst: false,
			initializer: null,
			type: null,
		});
	}

	function visit(node) {
		if (ts.isVariableDeclaration(node)) {
			const declarationList = ts.isVariableDeclarationList(node.parent) ? node.parent : null;
			const isBlockScoped = !!declarationList
				&& (declarationList.flags & ts.NodeFlags.BlockScoped) !== 0;
			const scope = ts.isCatchClause(node.parent)
				? node.parent
				: isBlockScoped
					? lexicalScopeFor(node)
					: functionOrSourceScopeFor(node);
			addBindingPattern(node.name, {
				node,
				scope,
				isConst: !!declarationList
					&& (declarationList.flags & ts.NodeFlags.Const) !== 0,
				initializer: node.initializer ?? null,
				type: node.type ?? null,
			});
		}
		if (ts.isParameter(node)) {
			addBindingPattern(node.name, {
				node,
				scope: node.parent,
				isConst: false,
				initializer: node.initializer ?? null,
				type: node.type ?? null,
			});
		}
		if (ts.isFunctionDeclaration(node)) {
			addBlockingDeclaration(node.name, node);
		} else if (ts.isFunctionExpression(node) && node.name) {
			addBlockingDeclaration(node.name, node, node);
		} else if (ts.isClassDeclaration(node)) {
			addBlockingDeclaration(node.name, node);
		} else if (ts.isClassExpression(node) && node.name) {
			addBlockingDeclaration(node.name, node, node);
		} else if (ts.isEnumDeclaration(node)) {
			addBlockingDeclaration(node.name, node);
		} else if (ts.isImportClause(node) && node.name) {
			addBlockingDeclaration(node.name, node);
		} else if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) {
			addBlockingDeclaration(node.name, node);
		} else if (ts.isImportEqualsDeclaration(node)) {
			addBlockingDeclaration(node.name, node);
		}
		ts.forEachChild(node, visit);
	}

	visit(sourceFile);
	return byName;
}

function nearestLexicalBinding(identifier, bindingsByName) {
	const candidates = (bindingsByName.get(identifier.text) ?? [])
		.filter((binding) => binding.scope && isDescendantOf(identifier, binding.scope));
	if (candidates.length === 0) return null;
	const deepestScope = Math.max(...candidates.map((binding) => nodeDepth(binding.scope)));
	const nearest = candidates.filter((binding) => nodeDepth(binding.scope) === deepestScope);
	if (nearest.length !== 1) return null;
	return nearest[0];
}

function foldStaticString(node, bindingsByName, resolving = new Set()) {
	const expression = unwrapTransparentExpression(node);
	if (!expression) return null;
	if (ts.isStringLiteralLike(expression)) return expression.text;
	if (
		ts.isBinaryExpression(expression)
		&& expression.operatorToken.kind === ts.SyntaxKind.PlusToken
	) {
		const left = foldStaticString(expression.left, bindingsByName, resolving);
		const right = foldStaticString(expression.right, bindingsByName, resolving);
		return left !== null && right !== null ? left + right : null;
	}
	if (ts.isIdentifier(expression)) {
		const binding = nearestLexicalBinding(expression, bindingsByName);
		if (
			!binding
			|| !binding.isConst
			|| !binding.initializer
			|| binding.node.getStart() >= expression.getStart()
			|| resolving.has(binding.node)
		) return null;
		const nextResolving = new Set(resolving);
		nextResolving.add(binding.node);
		return foldStaticString(binding.initializer, bindingsByName, nextResolving);
	}
	return null;
}

function staticPropertyName(name, bindingsByName) {
	if (!name) return null;
	if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
		return name.text;
	}
	if (ts.isComputedPropertyName(name)) {
		return foldStaticString(name.expression, bindingsByName);
	}
	return null;
}

function propertyAccessName(node, bindingsByName) {
	if (ts.isPropertyAccessExpression(node)) return node.name.text;
	if (ts.isElementAccessExpression(node) && node.argumentExpression) {
		return foldStaticString(node.argumentExpression, bindingsByName);
	}
	return null;
}

function isDirectCallTarget(node) {
	let current = node;
	while (
		current.parent
		&& (
			ts.isParenthesizedExpression(current.parent)
			|| ts.isAsExpression(current.parent)
			|| ts.isTypeAssertionExpression(current.parent)
			|| ts.isNonNullExpression(current.parent)
			|| ts.isSatisfiesExpression(current.parent)
		)
		&& current.parent.expression === current
	) {
		current = current.parent;
	}
	return ts.isCallExpression(current.parent) && current.parent.expression === current;
}

function outerTransparentNode(node) {
	let current = node;
	while (
		current.parent
		&& (
			ts.isParenthesizedExpression(current.parent)
			|| ts.isAsExpression(current.parent)
			|| ts.isTypeAssertionExpression(current.parent)
			|| ts.isNonNullExpression(current.parent)
			|| ts.isSatisfiesExpression(current.parent)
		)
		&& current.parent.expression === current
	) current = current.parent;
	return current;
}

function propertyStageSuffix(property, bindingsByName) {
	if (!ts.isObjectLiteralExpression(property.parent)) return "";
	for (const sibling of property.parent.properties) {
		if (
			ts.isPropertyAssignment(sibling)
			&& staticPropertyName(sibling.name, bindingsByName) === "stage"
		) {
			const stage = foldStaticString(sibling.initializer, bindingsByName);
			if (stage !== null) return `[stage=${JSON.stringify(stage)}]`;
		}
	}
	return "";
}

function assignedSyntaxName(node, bindingsByName) {
	const current = outerTransparentNode(node);

	const parent = current.parent;
	if (
		(ts.isVariableDeclaration(parent) || ts.isParameter(parent))
		&& parent.initializer === current
		&& ts.isIdentifier(parent.name)
	) return parent.name.text;
	if (ts.isPropertyAssignment(parent) && parent.initializer === current) {
		const propertyName = staticPropertyName(parent.name, bindingsByName);
		return propertyName
			? `${propertyName}${propertyStageSuffix(parent, bindingsByName)}`
			: null;
	}
	if (
		ts.isBinaryExpression(parent)
		&& parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
		&& parent.right === current
	) {
		const target = unwrapTransparentExpression(parent.left);
		if (ts.isIdentifier(target)) return target.text;
		if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
			return propertyAccessName(target, bindingsByName);
		}
	}
	return null;
}

function callArgumentBoundaryName(node, bindingsByName) {
	const current = outerTransparentNode(node);
	const parent = current.parent;
	if (!ts.isCallExpression(parent)) return null;
	const argumentIndex = parent.arguments.indexOf(current);
	if (argumentIndex < 0) return null;
	const staticArgumentSuffix = parent.arguments
		.flatMap((argument, index) => {
			if (argument === current) return [];
			const value = foldStaticString(argument, bindingsByName);
			return value === null ? [] : [`[arg${index}=${JSON.stringify(value)}]`];
		})
		.join("");
	const branchSegments = [];
	let ancestor = parent.parent;
	while (ancestor && !ts.isFunctionLike(ancestor)) {
		if (ts.isIfStatement(ancestor)) {
			if (isDescendantOf(parent, ancestor.thenStatement)) {
				branchSegments.push("[branch=then]");
			} else if (ancestor.elseStatement && isDescendantOf(parent, ancestor.elseStatement)) {
				branchSegments.push("[branch=else]");
			}
		} else if (ts.isConditionalExpression(ancestor)) {
			if (isDescendantOf(parent, ancestor.whenTrue)) {
				branchSegments.push("[branch=whenTrue]");
			} else if (isDescendantOf(parent, ancestor.whenFalse)) {
				branchSegments.push("[branch=whenFalse]");
			}
		}
		ancestor = ancestor.parent;
	}
	return `${calleeName(parent, bindingsByName) ?? "call"}#arg${argumentIndex}`
		+ staticArgumentSuffix
		+ branchSegments.join("");
}

function anonymousBoundaryName(node, sourceFile) {
	const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
	return `anonymous@${position.line + 1}:${position.character + 1}`;
}

function functionBoundaryName(node, sourceFile, bindingsByName) {
	if (
		ts.isMethodDeclaration(node)
		|| ts.isMethodSignature(node)
		|| ts.isGetAccessorDeclaration(node)
		|| ts.isSetAccessorDeclaration(node)
	) return nodeName(node, sourceFile);
	if (ts.isConstructorDeclaration(node)) return "constructor";
	if (ts.isFunctionDeclaration(node)) return node.name?.text ?? null;
	if (ts.isFunctionExpression(node)) {
		return assignedSyntaxName(node, bindingsByName)
			?? node.name?.text
			?? callArgumentBoundaryName(node, bindingsByName)
			?? anonymousBoundaryName(node, sourceFile);
	}
	if (ts.isArrowFunction(node)) {
		return assignedSyntaxName(node, bindingsByName)
			?? callArgumentBoundaryName(node, bindingsByName)
			?? anonymousBoundaryName(node, sourceFile);
	}
	return null;
}

function classBoundaryName(node, bindingsByName) {
	if (ts.isClassDeclaration(node)) return node.name?.text ?? null;
	if (ts.isClassExpression(node)) {
		return assignedSyntaxName(node, bindingsByName) ?? node.name?.text ?? null;
	}
	return null;
}

function containingPolicyOwner(node, sourceFile, bindingsByName, includeSelf = false) {
	const boundaries = [];
	let leaf = null;
	let current = includeSelf ? node : node.parent;
	while (current) {
		const functionName = ts.isFunctionLike(current)
			? functionBoundaryName(current, sourceFile, bindingsByName)
			: null;
		if (functionName) {
			if (!leaf) leaf = current;
			boundaries.push(functionName);
		} else if (ts.isClassLike(current)) {
			const className = classBoundaryName(current, bindingsByName);
			if (className) boundaries.push(className);
		} else if (ts.isObjectLiteralExpression(current)) {
			const objectName = assignedSyntaxName(current, bindingsByName);
			if (objectName) boundaries.push(objectName);
		}
		current = current.parent;
	}
	if (!leaf || boundaries.length === 0) return null;
	return { path: boundaries.reverse().join("."), node: leaf };
}

function isAssignmentBindingProperty(node) {
	let current = node;
	while (current.parent) {
		const parent = current.parent;
		if (
			ts.isBinaryExpression(parent)
			&& parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
			&& parent.left === current
		) return true;
		if (
			(ts.isForInStatement(parent) || ts.isForOfStatement(parent))
			&& parent.initializer === current
		) return true;
		if (
			(ts.isObjectLiteralExpression(parent) && parent.properties.includes(current))
			|| (ts.isArrayLiteralExpression(parent) && parent.elements.includes(current))
			|| (ts.isPropertyAssignment(parent) && parent.initializer === current)
			|| (ts.isParenthesizedExpression(parent) && parent.expression === current)
			|| (ts.isSpreadAssignment(parent) && parent.expression === current)
			|| (ts.isSpreadElement(parent) && parent.expression === current)
		) {
			current = parent;
			continue;
		}
		return false;
	}
	return false;
}

function lineOf(sourceFile, node) {
	return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function entityNameLeaf(name) {
	let current = name;
	while (ts.isQualifiedName(current)) current = current.right;
	return ts.isIdentifier(current) ? current.text : null;
}

function isNullishType(typeNode) {
	return typeNode.kind === ts.SyntaxKind.UndefinedKeyword
		|| typeNode.kind === ts.SyntaxKind.NeverKeyword
		|| (
			ts.isLiteralTypeNode(typeNode)
			&& typeNode.literal.kind === ts.SyntaxKind.NullKeyword
		);
}

function typeEstablishesVaultSync(typeNode) {
	if (!typeNode) return false;
	if (ts.isParenthesizedTypeNode(typeNode)) {
		return typeEstablishesVaultSync(typeNode.type);
	}
	if (ts.isTypeReferenceNode(typeNode)) {
		const typeName = entityNameLeaf(typeNode.typeName);
		if (typeName === "VaultSync") return true;
		if (
			ts.isIdentifier(typeNode.typeName)
			&& ["Readonly", "Required", "Partial", "NonNullable"].includes(typeName)
			&& typeNode.typeArguments?.length === 1
		) return typeEstablishesVaultSync(typeNode.typeArguments[0]);
		return false;
	}
	if (ts.isImportTypeNode(typeNode) && typeNode.qualifier) {
		return entityNameLeaf(typeNode.qualifier) === "VaultSync";
	}
	if (ts.isUnionTypeNode(typeNode)) {
		const possibleRuntimeTypes = typeNode.types.filter((entry) => !isNullishType(entry));
		return possibleRuntimeTypes.length > 0
			&& possibleRuntimeTypes.every(typeEstablishesVaultSync);
	}
	if (ts.isIntersectionTypeNode(typeNode)) {
		return typeNode.types.some(typeEstablishesVaultSync);
	}
	return false;
}

function enclosingClass(node) {
	let current = node.parent;
	while (current) {
		if (ts.isClassLike(current)) return current;
		current = current.parent;
	}
	return null;
}

function classMemberType(classNode, propertyName, sourceFile, bindingsByName, resolving) {
	for (const member of classNode.members) {
		if (
			ts.isPropertyDeclaration(member)
			&& staticPropertyName(member.name, bindingsByName) === propertyName
		) {
			if (typeEstablishesVaultSync(member.type)) return true;
			if (member.initializer && !resolving.has(member)) {
				const nextResolving = new Set(resolving);
				nextResolving.add(member);
				if (isSyntacticallyVaultSyncReceiver(
					member.initializer,
					sourceFile,
					bindingsByName,
					nextResolving,
				)) return true;
			}
		}
		if (
			ts.isGetAccessorDeclaration(member)
			&& staticPropertyName(member.name, bindingsByName) === propertyName
			&& typeEstablishesVaultSync(member.type)
		) return true;
		if (ts.isConstructorDeclaration(member)) {
			for (const parameter of member.parameters) {
				if (
					ts.isParameterPropertyDeclaration(parameter, member)
					&& ts.isIdentifier(parameter.name)
					&& parameter.name.text === propertyName
					&& typeEstablishesVaultSync(parameter.type)
				) return true;
			}
		}
	}
	return false;
}

function isSyntacticallyVaultSyncReceiver(node, sourceFile, bindingsByName, resolving = new Set()) {
	let current = node;
	while (
		current
		&& (
			ts.isParenthesizedExpression(current)
			|| ts.isAsExpression(current)
			|| ts.isTypeAssertionExpression(current)
			|| ts.isNonNullExpression(current)
			|| ts.isSatisfiesExpression(current)
		)
	) {
		if (
			(ts.isAsExpression(current)
				|| ts.isTypeAssertionExpression(current)
				|| ts.isSatisfiesExpression(current))
			&& typeEstablishesVaultSync(current.type)
		) return true;
		current = current.expression;
	}
	const expression = current;
	if (!expression) return false;
	if (ts.isIdentifier(expression)) {
		const binding = nearestLexicalBinding(expression, bindingsByName);
		if (!binding) return false;
		if (typeEstablishesVaultSync(binding.type)) return true;
		if (
			!binding.isConst
			|| !binding.initializer
			|| binding.node.getStart() >= expression.getStart()
			|| resolving.has(binding.node)
		) return false;
		const nextResolving = new Set(resolving);
		nextResolving.add(binding.node);
		return isSyntacticallyVaultSyncReceiver(
			binding.initializer,
			sourceFile,
			bindingsByName,
			nextResolving,
		);
	}
	if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
		const receiver = unwrapTransparentExpression(expression.expression);
		const propertyName = propertyAccessName(expression, bindingsByName);
		if (receiver?.kind === ts.SyntaxKind.ThisKeyword && propertyName) {
			const classNode = enclosingClass(expression);
			return !!classNode && classMemberType(
				classNode,
				propertyName,
				sourceFile,
				bindingsByName,
				resolving,
			);
		}
	}
	if (ts.isNewExpression(expression)) {
		const constructor = unwrapTransparentExpression(expression.expression);
		if (ts.isIdentifier(constructor)) return constructor.text === "VaultSync";
		if (ts.isPropertyAccessExpression(constructor) || ts.isElementAccessExpression(constructor)) {
			return propertyAccessName(constructor, bindingsByName) === "VaultSync";
		}
	}
	return false;
}

function calleeName(call, bindingsByName) {
	const expression = unwrapTransparentExpression(call.expression);
	if (ts.isIdentifier(expression)) return expression.text;
	if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
		return propertyAccessName(expression, bindingsByName);
	}
	return null;
}

function isInDirectOwnerScope(node, ownerNode) {
	let current = node.parent;
	while (current && current !== ownerNode) {
		if (ts.isFunctionLike(current)) return false;
		current = current.parent;
	}
	return current === ownerNode;
}

function isInsideTypeNode(node) {
	let current = node.parent;
	while (current && !ts.isStatement(current) && !ts.isSourceFile(current)) {
		if (ts.isTypeNode(current)) return true;
		current = current.parent;
	}
	return false;
}

function isRuntimeIdentifierReference(node) {
	if (isInsideTypeNode(node)) return false;
	const parent = node.parent;
	if (!parent) return false;
	if (
		("name" in parent && parent.name === node)
		&& (
			ts.isDeclaration(parent)
			|| ts.isMethodDeclaration(parent)
			|| ts.isPropertyAssignment(parent)
			|| ts.isBindingElement(parent)
		)
	) return ts.isShorthandPropertyAssignment(parent);
	if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
	if (ts.isQualifiedName(parent)) return false;
	if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return false;
	if (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) return false;
	return true;
}

export function formatEnsureFileViolation(violation) {
	return `${violation.path}:${violation.line} [${violation.category}] ${violation.message}`;
}

export function analyzeEnsureFileSource(relativePath, sourceText) {
	const sourceFile = ts.createSourceFile(
		relativePath,
		sourceText,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const bindingsByName = collectLexicalBindings(sourceFile);
	const observedCounts = new Map();
	const ownerEvidence = new Map();
	const ownerNodes = new Map();
	const violations = [];

	function ownerKey(owner) {
		return `${relativePath}\u0000${owner.path}`;
	}

	function registerOwner(owner) {
		const key = ownerKey(owner);
		const nodes = ownerNodes.get(key) ?? new Set();
		nodes.add(owner.node);
		ownerNodes.set(key, nodes);
		return key;
	}

	function evidenceFor(owner) {
		const key = registerOwner(owner);
		let evidence = ownerEvidence.get(key);
		if (!evidence) {
			evidence = { calls: new Set(), runtimeIdentifiers: new Set() };
			ownerEvidence.set(key, evidence);
		}
		return evidence;
	}

	function report(category, node, message) {
		violations.push({
			category,
			path: relativePath,
			line: lineOf(sourceFile, node),
			message,
		});
	}

	function visit(node) {
		if (ts.isFunctionLike(node)) {
			const owner = containingPolicyOwner(node, sourceFile, bindingsByName, true);
			if (owner?.node === node) registerOwner(owner);
		}
		if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
			const propertyName = propertyAccessName(node, bindingsByName);
			if (propertyName === "ensureFile") {
				if (!isDirectCallTarget(node)) {
					report("non-direct-access", node, "ensureFile property access is not a direct call target");
				} else {
					const owner = containingPolicyOwner(node, sourceFile, bindingsByName);
					if (!owner) {
							report("unnamed-owner", node, "direct ensureFile call has no named policy owner");
						} else {
							const key = registerOwner(owner);
						observedCounts.set(key, (observedCounts.get(key) ?? 0) + 1);
						evidenceFor(owner);
					}
				}
			} else if (
				ts.isElementAccessExpression(node)
				&& propertyName === null
				&& isSyntacticallyVaultSyncReceiver(node.expression, sourceFile, bindingsByName)
			) {
				report(
					"unresolved-computed-vault-access",
					node,
					"computed VaultSync property cannot be resolved statically",
				);
			}
		}

		if (ts.isCallExpression(node)) {
			const name = calleeName(node, bindingsByName);
			const expression = unwrapTransparentExpression(node.expression);
			if (name === "ensureFile" && ts.isIdentifier(expression)) {
				report("bare-alias-call", node, "calls a bare ensureFile alias");
			}
			if (name && name !== "ensureFile") {
				const owner = containingPolicyOwner(node, sourceFile, bindingsByName);
				if (owner && isInDirectOwnerScope(node, owner.node)) {
					evidenceFor(owner).calls.add(name);
				}
			}
		}

		if (ts.isIdentifier(node) && isRuntimeIdentifierReference(node)) {
			const owner = containingPolicyOwner(node, sourceFile, bindingsByName);
			if (owner && isInDirectOwnerScope(node, owner.node)) {
				evidenceFor(owner).runtimeIdentifiers.add(node.text);
			}
		}

		if (ts.isBindingElement(node)) {
			const bindingName = ts.isIdentifier(node.name) ? node.name.text : null;
			const propertyName = staticPropertyName(node.propertyName, bindingsByName);
			if (bindingName === "ensureFile" || propertyName === "ensureFile") {
				report("binding-alias", node, "destructures or binds ensureFile");
			}
		}

		if (
			(ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node))
			&& staticPropertyName(node.name, bindingsByName) === "ensureFile"
			&& isAssignmentBindingProperty(node)
		) {
			report("binding-alias", node, "assignment destructures or binds ensureFile");
		}

		ts.forEachChild(node, visit);
	}

	visit(sourceFile);
	for (const key of observedCounts.keys()) {
		const nodes = [...(ownerNodes.get(key) ?? [])];
		if (nodes.length <= 1) continue;
		report(
			"owner-key-collision",
			nodes[1],
			`distinct lexical owners collapse to ${key.split("\u0000")[1]}`,
		);
	}
	const ownerNodeCounts = new Map(
		[...ownerNodes.entries()].map(([key, nodes]) => [key, nodes.size]),
	);
	return { observedCounts, ownerEvidence, ownerNodeCounts, violations };
}
