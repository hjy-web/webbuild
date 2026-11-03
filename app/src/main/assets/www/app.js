
(function() {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const SVG_TAGS = new Set(['svg', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'g', 'defs', 'linearGradient', 'stop', 'clipPath']);

  let hooks = [];
  let hookIdx = 0;
  let pendingEffects = [];
  let renderScheduled = false;
  let rootContainer = null;
  let rootComponent = null;
  let currentVTree = null;

  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    Promise.resolve().then(() => {
      renderScheduled = false;
      performRender();
    });
  }

  function useState(initial) {
    const idx = hookIdx++;
    if (idx >= hooks.length) {
      const initVal = typeof initial === 'function' ? initial() : initial;
      hooks[idx] = { type: 'state', value: initVal };
    }
    const hook = hooks[idx];
    const setState = (updater) => {
      const nextVal = typeof updater === 'function' ? updater(hook.value) : updater;
      if (!Object.is(nextVal, hook.value)) {
        hook.value = nextVal;
        scheduleRender();
      }
    };
    return [hook.value, setState];
  }

  function useRef(initial) {
    const idx = hookIdx++;
    if (idx >= hooks.length) {
      hooks[idx] = { type: 'ref', refObj: { current: initial } };
    }
    return hooks[idx].refObj;
  }

  function depsChanged(oldDeps, newDeps) {
    if (!oldDeps || !newDeps) return true;
    if (oldDeps.length !== newDeps.length) return true;
    for (let i = 0; i < oldDeps.length; i++) {
      if (!Object.is(oldDeps[i], newDeps[i])) return true;
    }
    return false;
  }

  function useEffect(effectFn, deps) {
    const idx = hookIdx++;
    if (idx >= hooks.length) {
      hooks[idx] = { type: 'effect', deps: undefined, cleanup: null, initialized: false };
    }
    const hook = hooks[idx];
    if (!hook.initialized || deps === undefined || depsChanged(hook.deps, deps)) {
      hook.initialized = true;
      hook.deps = deps;
      pendingEffects.push(hook);
      hook.nextEffect = effectFn;
    }
  }

  function flattenChildren(raw, out) {
    for (let i = 0; i < raw.length; i++) {
      const item = raw[i];
      if (Array.isArray(item)) {
        flattenChildren(item, out);
      } else if (item === null || item === undefined || typeof item === 'boolean') {
        out.push({ type: '#empty', key: null });
      } else if (typeof item === 'string' || typeof item === 'number') {
        out.push({ type: '#text', text: String(item), key: null });
      } else if (item && typeof item === 'object') {
        out.push(item);
      }
    }
  }

  const Fragment = Symbol('Fragment');
  const StrictMode = function StrictMode(props) { return props.children; };

  function createElement(type, props, ...rawChildren) {
    const children = [];
    flattenChildren(rawChildren, children);
    if (type === Fragment || type === StrictMode) {
      return { type: Fragment, props: props || {}, children, key: props?.key ?? null };
    }
    if (typeof type === 'function') {
      if (type !== window.App) {
        const res = type(Object.assign({}, props || {}, { children }));
        if (res && props && props.key != null) res.key = props.key;
        return res;
      }
      return { type, props: props || {}, children, key: props?.key ?? null };
    }
    return {
      type,
      props: props || {},
      children,
      key: props?.key ?? null,
      ref: props?.ref ?? null
    };
  }

  function unwrapFragments(vnodes, out) {
    for (let i = 0; i < vnodes.length; i++) {
      const v = vnodes[i];
      if (!v) {
        out.push({ type: '#empty', key: null });
        continue;
      }
      if (v.type === Fragment) {
        unwrapFragments(v.children || [], out);
      } else {
        out.push(v);
      }
    }
  }

  function applyProps(dom, oldProps, newProps, isSvg) {
    const allKeys = new Set([...Object.keys(oldProps || {}), ...Object.keys(newProps || {})]);
    for (const k of allKeys) {
      if (k === 'children' || k === 'key' || k === 'ref') continue;
      const oldVal = oldProps ? oldProps[k] : undefined;
      const newVal = newProps ? newProps[k] : undefined;
      if (Object.is(oldVal, newVal) && k !== 'value' && k !== 'checked') continue;

      if (k.startsWith('on') && k.length > 2) {
        if (!dom.__handlers) dom.__handlers = {};
        dom.__handlers[k] = newVal;
        if (!dom.__boundEvents) dom.__boundEvents = {};
        let evtName = k.slice(2).toLowerCase();
        if (k === 'onChange') {
          const tag = dom.tagName;
          const inpType = dom.getAttribute('type');
          if ((tag === 'INPUT' && inpType !== 'checkbox' && inpType !== 'radio' && inpType !== 'file') || tag === 'TEXTAREA') {
            evtName = 'input';
          } else {
            evtName = 'change';
          }
        } else if (k === 'onDoubleClick') {
          evtName = 'dblclick';
        }
        if (!dom.__boundEvents[evtName]) {
          dom.__boundEvents[evtName] = true;
          dom.addEventListener(evtName, (e) => {
            if (!e.nativeEvent) e.nativeEvent = e;
            const fn = dom.__handlers[k];
            if (typeof fn === 'function') fn(e);
          });
        }
        continue;
      }

      if (k === 'style') {
        if (!newVal) {
          dom.removeAttribute('style');
        } else if (typeof newVal === 'string') {
          dom.style.cssText = newVal;
        } else if (typeof newVal === 'object') {
          if (oldVal && typeof oldVal === 'object') {
            for (const sk of Object.keys(oldVal)) {
              if (!(sk in newVal)) dom.style[sk] = '';
            }
          }
          for (const [sk, sv] of Object.entries(newVal)) {
            dom.style[sk] = sv ?? '';
          }
        }
        continue;
      }

      if (k === 'className') {
        if (isSvg) {
          if (newVal) dom.setAttribute('class', newVal);
          else dom.removeAttribute('class');
        } else {
          dom.className = newVal || '';
        }
        continue;
      }

      if (k === 'value' && (dom.tagName === 'INPUT' || dom.tagName === 'TEXTAREA' || dom.tagName === 'SELECT')) {
        const strVal = newVal == null ? '' : String(newVal);
        if (dom.value !== strVal) {
          dom.value = strVal;
        }
        continue;
      }

      if (k === 'checked' && dom.tagName === 'INPUT') {
        dom.checked = Boolean(newVal);
        continue;
      }

      if (k === 'disabled' || k === 'multiple' || k === 'controls' || k === 'playsInline' || k === 'autoFocus') {
        dom[k] = Boolean(newVal);
        if (newVal) dom.setAttribute(k.toLowerCase(), '');
        else dom.removeAttribute(k.toLowerCase());
        continue;
      }

      const attrMap = {
        strokeWidth: 'stroke-width',
        strokeLinecap: 'stroke-linecap',
        strokeLinejoin: 'stroke-linejoin',
        fillRule: 'fill-rule',
        clipRule: 'clip-rule',
        maxLength: 'maxlength',
      };
      const attrName = attrMap[k] || k;
      if (newVal === null || newVal === undefined || newVal === false) {
        dom.removeAttribute(attrName);
      } else {
        dom.setAttribute(attrName, String(newVal));
      }
    }
  }

  function createDom(vnode, isSvgParent) {
    if (vnode.type === '#empty') {
      const node = document.createComment('');
      vnode._dom = node;
      return node;
    }
    if (vnode.type === '#text') {
      const node = document.createTextNode(vnode.text);
      vnode._dom = node;
      return node;
    }
    const isSvg = isSvgParent || SVG_TAGS.has(vnode.type);
    const dom = isSvg
      ? document.createElementNS(SVG_NS, vnode.type)
      : document.createElement(vnode.type);
    vnode._dom = dom;

    const flatKids = [];
    unwrapFragments(vnode.children || [], flatKids);
    vnode._flatChildren = flatKids;
    for (let i = 0; i < flatKids.length; i++) {
      dom.appendChild(createDom(flatKids[i], isSvg));
    }

    applyProps(dom, null, vnode.props, isSvg);

    if (vnode.ref) {
      if (typeof vnode.ref === 'function') vnode.ref(dom);
      else if (typeof vnode.ref === 'object') vnode.ref.current = dom;
    }
    return dom;
  }

  function syncNode(parentDom, oldVNode, newVNode, isSvgParent) {
    if (oldVNode.type !== newVNode.type) {
      const newDom = createDom(newVNode, isSvgParent);
      if (oldVNode._dom && oldVNode._dom.parentNode === parentDom) {
        parentDom.replaceChild(newDom, oldVNode._dom);
      }
      return newDom;
    }
    const dom = oldVNode._dom;
    newVNode._dom = dom;
    if (newVNode.type === '#empty') {
      return dom;
    }
    if (newVNode.type === '#text') {
      if (oldVNode.text !== newVNode.text) {
        dom.nodeValue = newVNode.text;
      }
      return dom;
    }
    const isSvg = isSvgParent || SVG_TAGS.has(newVNode.type);
    const oldKids = oldVNode._flatChildren || [];
    const newKids = [];
    unwrapFragments(newVNode.children || [], newKids);
    newVNode._flatChildren = newKids;

    reconcileChildren(dom, oldKids, newKids, isSvg);
    applyProps(dom, oldVNode.props, newVNode.props, isSvg);

    if (newVNode.ref) {
      if (typeof newVNode.ref === 'function') newVNode.ref(dom);
      else if (typeof newVNode.ref === 'object') newVNode.ref.current = dom;
    }
    return dom;
  }

  function reconcileChildren(parentDom, oldKids, newKids, isSvg) {
    const oldKeyed = new Map();
    const oldUnkeyed = [];
    for (let i = 0; i < oldKids.length; i++) {
      const k = oldKids[i].key;
      if (k != null) oldKeyed.set(String(k), oldKids[i]);
      else oldUnkeyed.push(oldKids[i]);
    }
    let unkeyedIdx = 0;
    const usedOld = new Set();
    const newDoms = new Array(newKids.length);

    for (let i = 0; i < newKids.length; i++) {
      const newChild = newKids[i];
      let matchedOld = null;
      if (newChild.key != null) {
        matchedOld = oldKeyed.get(String(newChild.key)) || null;
      } else if (unkeyedIdx < oldUnkeyed.length) {
        matchedOld = oldUnkeyed[unkeyedIdx++];
      }
      if (matchedOld) {
        usedOld.add(matchedOld);
        newDoms[i] = syncNode(parentDom, matchedOld, newChild, isSvg);
      } else {
        newDoms[i] = createDom(newChild, isSvg);
      }
    }

    for (let i = 0; i < oldKids.length; i++) {
      const oldChild = oldKids[i];
      if (!usedOld.has(oldChild) && oldChild._dom && oldChild._dom.parentNode === parentDom) {
        parentDom.removeChild(oldChild._dom);
      }
    }

    for (let i = 0; i < newDoms.length; i++) {
      const domNode = newDoms[i];
      const currentAtPos = parentDom.childNodes[i];
      if (domNode !== currentAtPos) {
        parentDom.insertBefore(domNode, currentAtPos || null);
      }
    }
  }

  function performRender() {
    if (!rootContainer || !rootComponent) return;
    hookIdx = 0;
    pendingEffects = [];
    let nextVTree = rootComponent();
    if (nextVTree && typeof nextVTree.type === 'function') {
      nextVTree = nextVTree.type(nextVTree.props || {});
    }
    if (!currentVTree) {
      rootContainer.innerHTML = '';
      rootContainer.appendChild(createDom(nextVTree, false));
    } else {
      syncNode(rootContainer, currentVTree, nextVTree, false);
    }
    currentVTree = nextVTree;

    const effectsToRun = pendingEffects.slice();
    pendingEffects = [];
    for (let i = 0; i < effectsToRun.length; i++) {
      const eff = effectsToRun[i];
      try {
        if (typeof eff.cleanup === 'function') {
          eff.cleanup();
          eff.cleanup = null;
        }
        const res = eff.nextEffect();
        if (typeof res === 'function') eff.cleanup = res;
      } catch (err) {
        console.error('Effect error:', err);
      }
    }
  }

  function createRoot(container) {
    rootContainer = container;
    return {
      render(vnode) {
        if (vnode.type === StrictMode && vnode.children && vnode.children[0]) {
          vnode = vnode.children[0];
        }
        rootComponent = typeof vnode.type === 'function' ? () => vnode.type(vnode.props || {}) : () => vnode;
        performRender();
      }
    };
  }

  window.React = {
    createElement,
    Fragment,
    StrictMode,
    useState,
    useEffect,
    useRef
  };
  window.ReactDOMClient = { createRoot };
})();


(function() {
  const iconDefs = {"MessageSquare":[["path",{"d":"M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"}]],"Settings":[["circle",{"cx":"12","cy":"12","r":"3"}],["path",{"d":"M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"}]],"Terminal":[["polyline",{"points":"4 17 10 11 4 5"}],["line",{"x1":"12","y1":"19","x2":"20","y2":"19"}]],"Plus":[["line",{"x1":"12","y1":"5","x2":"12","y2":"19"}],["line",{"x1":"5","y1":"12","x2":"19","y2":"12"}]],"Sparkles":[["path",{"d":"m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3L12 3Z"}]],"Link2":[["path",{"d":"M9 17H7A5 5 0 0 1 7 7h2"}],["path",{"d":"M15 7h2a5 5 0 1 1 0 10h-2"}],["line",{"x1":"8","y1":"12","x2":"16","y2":"12"}]],"CheckCircle2":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"m9 12 2 2 4-4"}]],"RefreshCw":[["path",{"d":"M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"}],["path",{"d":"M21 3v5h-5"}],["path",{"d":"M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"}],["path",{"d":"M8 16H3v5"}]],"Copy":[["rect",{"width":"14","height":"14","x":"8","y":"8","rx":"2","ry":"2"}],["path",{"d":"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"}]],"Check":[["polyline",{"points":"20 6 9 17 4 12"}]],"Sliders":[["line",{"x1":"4","y1":"21","x2":"4","y2":"14"}],["line",{"x1":"4","y1":"10","x2":"4","y2":"3"}],["line",{"x1":"12","y1":"21","x2":"12","y2":"12"}],["line",{"x1":"12","y1":"8","x2":"12","y2":"3"}],["line",{"x1":"20","y1":"21","x2":"20","y2":"16"}],["line",{"x1":"20","y1":"12","x2":"20","y2":"3"}],["line",{"x1":"2","y1":"14","x2":"6","y2":"14"}],["line",{"x1":"10","y1":"8","x2":"14","y2":"8"}],["line",{"x1":"18","y1":"16","x2":"22","y2":"16"}]],"Eye":[["path",{"d":"M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"}],["circle",{"cx":"12","cy":"12","r":"3"}]],"ChevronRight":[["path",{"d":"m9 18 6-6-6-6"}]],"ChevronDown":[["path",{"d":"m6 9 6 6 6-6"}]],"ChevronLeft":[["path",{"d":"m15 18-6-6 6-6"}]],"Cpu":[["rect",{"x":"4","y":"4","width":"16","height":"16","rx":"2"}],["rect",{"x":"9","y":"9","width":"6","height":"6"}],["path",{"d":"M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2"}]],"Wifi":[["path",{"d":"M5 12.55a11 11 0 0 1 14.08 0"}],["path",{"d":"M1.42 9a16 16 0 0 1 21.16 0"}],["path",{"d":"M8.53 16.11a6 6 0 0 1 6.95 0"}],["line",{"x1":"12","y1":"20","x2":"12.01","y2":"20"}]],"Code2":[["path",{"d":"m18 16 4-4-4-4"}],["path",{"d":"m6 8-4 4 4 4"}],["path",{"d":"m14.5 4-5 16"}]],"Sun":[["circle",{"cx":"12","cy":"12","r":"4"}],["path",{"d":"M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"}]],"Moon":[["path",{"d":"M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"}]],"Layers":[["polygon",{"points":"12 2 2 7 12 12 22 7 12 2"}],["polyline",{"points":"2 17 12 22 22 17"}],["polyline",{"points":"2 12 12 17 22 12"}]],"Search":[["circle",{"cx":"11","cy":"11","r":"8"}],["path",{"d":"m21 21-4.3-4.3"}]],"ArrowUp":[["path",{"d":"m5 12 7-7 7 7"}],["path",{"d":"M12 19V5"}]],"PanelRight":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M15 3v18"}]],"PanelLeft":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M9 3v18"}]],"Flame":[["path",{"d":"M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"}]],"Radio":[["circle",{"cx":"12","cy":"12","r":"2"}],["path",{"d":"M4.93 19.07a10 10 0 0 1 0-14.14M19.07 4.93a10 10 0 0 1 0 14.14M7.76 16.24a6 6 0 0 1 0-8.49M16.24 7.76a6 6 0 0 1 0 8.49"}]],"X":[["path",{"d":"M18 6 6 18"}],["path",{"d":"m6 6 12 12"}]],"Palette":[["circle",{"cx":"13.5","cy":"6.5","r":".5"}],["circle",{"cx":"17.5","cy":"10.5","r":".5"}],["circle",{"cx":"8.5","cy":"7.5","r":".5"}],["circle",{"cx":"6.5","cy":"12.5","r":".5"}],["path",{"d":"M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"}]],"Upload":[["path",{"d":"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"}],["polyline",{"points":"17 8 12 3 7 8"}],["line",{"x1":"12","y1":"3","x2":"12","y2":"15"}]],"RotateCcw":[["path",{"d":"M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"}],["path",{"d":"M3 3v5h5"}]],"Video":[["path",{"d":"m22 8-6 4 6 4V8Z"}],["rect",{"width":"14","height":"12","x":"2","y":"6","rx":"2","ry":"2"}]],"Trash2":[["path",{"d":"M3 6h18"}],["path",{"d":"M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"}],["path",{"d":"M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"}]],"Pencil":[["path",{"d":"M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"}]],"Quote":[["path",{"d":"M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"}],["path",{"d":"M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"}]],"Download":[["path",{"d":"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"}],["polyline",{"points":"7 10 12 15 17 10"}],["line",{"x1":"12","y1":"15","x2":"12","y2":"3"}]],"Minus":[["path",{"d":"M5 12h14"}]],"CornerUpRight":[["polyline",{"points":"15 14 20 9 15 4"}],["path",{"d":"M4 20v-7a4 4 0 0 1 4-4h12"}]],"Share2":[["circle",{"cx":"18","cy":"5","r":"3"}],["circle",{"cx":"6","cy":"12","r":"3"}],["circle",{"cx":"18","cy":"19","r":"3"}],["line",{"x1":"8.59","y1":"13.51","x2":"15.42","y2":"17.49"}],["line",{"x1":"15.41","y1":"6.51","x2":"8.59","y2":"10.49"}]],"Pin":[["line",{"x1":"12","y1":"17","x2":"12","y2":"22"}],["path",{"d":"M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"}]],"Globe":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"}],["path",{"d":"M2 12h20"}]],"Smartphone":[["rect",{"width":"14","height":"20","x":"5","y":"2","rx":"2","ry":"2"}],["path",{"d":"M12 18h.01"}]],"Monitor":[["rect",{"width":"20","height":"14","x":"2","y":"3","rx":"2"}],["line",{"x1":"8","y1":"21","x2":"16","y2":"21"}],["line",{"x1":"12","y1":"17","x2":"12","y2":"21"}]],"ExternalLink":[["path",{"d":"M15 3h6v6"}],["path",{"d":"M10 14 21 3"}],["path",{"d":"M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"}]],"SplitSquareVertical":[["path",{"d":"M5 8V5c0-1 1-2 2-2h10c1 0 2 1 2 2v3"}],["path",{"d":"M19 16v3c0 1-1 2-2 2H7c-1 0-2-1-2-2v-3"}],["line",{"x1":"4","y1":"12","x2":"20","y2":"12"}]],"ShieldCheck":[["path",{"d":"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"}],["path",{"d":"m9 12 2 2 4-4"}]],"Play":[["polygon",{"points":"6 3 20 12 6 21 6 3"}]],"Send":[["path",{"d":"m22 2-7 20-4-9-9-4Z"}],["path",{"d":"M22 2 11 13"}]],"Maximize2":[["polyline",{"points":"15 3 21 3 21 9"}],["polyline",{"points":"9 21 3 21 3 15"}],["line",{"x1":"21","y1":"3","x2":"14","y2":"10"}],["line",{"x1":"3","y1":"21","x2":"10","y2":"14"}]],"Minimize2":[["polyline",{"points":"4 14 10 14 10 20"}],["polyline",{"points":"20 10 14 10 14 4"}],["line",{"x1":"14","y1":"10","x2":"21","y2":"3"}],["line",{"x1":"3","y1":"21","x2":"10","y2":"14"}]]};
  const LucideIcons = {};
  for (const [name, shapes] of Object.entries(iconDefs)) {
    LucideIcons[name] = function(props) {
      const p = props || {};
      const children = shapes.map(([tag, attrs], idx) =>
        window.React.createElement(tag, Object.assign({ key: idx }, attrs))
      );
      return window.React.createElement('svg', {
        xmlns: 'http://www.w3.org/2000/svg',
        width: p.size || 24,
        height: p.size || 24,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: p.strokeWidth || 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        className: p.className || '',
        style: p.style
      }, ...children);
    };
  }
  window.LucideIcons = LucideIcons;
})();

const {
  useState,
  useEffect,
  useRef
} = window.React;
const bridgeSource = "import { promises as fs } from 'node:fs';\nimport path from 'node:path';\nimport { fileURLToPath } from 'node:url';\nimport { chromium } from 'playwright';\nimport { WebSocketServer } from 'ws';\n\nconst HERE = path.dirname(fileURLToPath(import.meta.url));\nconst STATE_FILE = path.join(HERE, 'web_h_userdata.json');\nconst CDP_URL = process.env.WEB_H_CDP_URL || 'http://127.0.0.1:9222';\nconst WS_PORT = Number(process.env.WEB_H_BRIDGE_PORT || 8765);\nconst REPLY_TIMEOUT_MS = 90_000;\nconst INPUT_FALLBACKS = [\n  '#chat-input', '#prompt-textarea', 'div.ProseMirror[contenteditable=\"true\"]',\n  'rich-textarea div[contenteditable=\"true\"]', '[contenteditable=\"true\"]',\n  'textarea:not([disabled]):not(#pending-conversation-input)',\n  '[role=\"textbox\"]', 'input[type=\"text\"]'\n];\nconst SEND_FALLBACKS = [\n  'button[data-testid=\"send-button\"]', 'button[aria-label*=\"Send\"]',\n  'button[aria-label*=\"\u53d1\u9001\"]', 'button[type=\"submit\"]',\n  '[role=\"button\"][aria-label*=\"Send\"]', '[role=\"button\"][aria-label*=\"\u53d1\u9001\"]'\n];\nconst ASSISTANT_SELECTORS = [\n  '[data-message-author-role=\"assistant\"] div.markdown',\n  '[data-message-author-role=\"assistant\"]',\n  '[data-testid*=\"conversation-turn\"] [data-message-author-role=\"assistant\"]',\n  '.ds-markdown', '.font-claude-message', 'message-content',\n  '[class*=\"assistant\"] .markdown-body',\n  '[data-testid*=\"assistant-message\"]',\n  '.markdown-body', '.prose'\n].join(',');\n\nconst GENERATING_INDICATORS = [\n  'button[data-testid=\"stop-button\"]',\n  'button[aria-label*=\"Stop\"]',\n  'button[aria-label*=\"\u505c\u6b62\"]',\n  'button[aria-label*=\"Cancel\"]',\n  'button.ds-stop-btn',\n  '.result-thinking',\n  '.streaming',\n  '[data-testid*=\"stop\"]'\n].join(',');\n\nlet savedState = null;\nlet saveQueue = Promise.resolve();\nlet browser = null;\nlet browserContext = null;\nlet connectPromise = null;\nconst taskQueues = new Map();\n\nfunction send(ws, payload) {\n  if (ws.readyState === 1) ws.send(JSON.stringify(payload));\n}\n\nfunction replyError(ws, command, error) {\n  const message = error instanceof Error ? error.message : String(error);\n  console.error(`\u4efb\u52a1\u5931\u8d25 (${command.botId || 'unknown'}): ${message}`);\n  send(ws, {\n    type: 'BOT_ERROR', botId: command.botId, groupId: command.groupId,\n    requestId: command.requestId, syncThrough: command.syncThrough,\n    message: `\u7f51\u9875\u6865\u63a5\u5931\u8d25\uff1a${message}`\n  });\n}\n\nasync function loadSavedState() {\n  try {\n    const raw = await fs.readFile(STATE_FILE, 'utf8');\n    const parsed = JSON.parse(raw);\n    if (parsed && typeof parsed === 'object') savedState = parsed;\n  } catch (error) {\n    if (error.code !== 'ENOENT') console.warn('\u8bfb\u53d6\u672c\u5730\u72b6\u6001\u5931\u8d25\uff1a', error.message);\n  }\n}\n\nfunction saveState(snapshot) {\n  if (savedState) {\n    const { savedAt: _oldSavedAt, ...oldContent } = savedState;\n    const { savedAt: _newSavedAt, ...newContent } = snapshot;\n    if (JSON.stringify(oldContent) === JSON.stringify(newContent)) return Promise.resolve(false);\n  }\n  savedState = snapshot;\n  saveQueue = saveQueue.catch(() => {}).then(async () => {\n    const temporaryFile = `${STATE_FILE}.tmp`;\n    await fs.writeFile(temporaryFile, JSON.stringify(snapshot, null, 2), 'utf8');\n    await fs.rename(temporaryFile, STATE_FILE);\n  });\n  return saveQueue;\n}\n\nasync function getContext() {\n  if (browser?.isConnected() && browserContext) return browserContext;\n  if (connectPromise) return connectPromise;\n  connectPromise = (async () => {\n    try {\n      browser = await chromium.connectOverCDP(CDP_URL, { timeout: 5000 });\n      browser.on('disconnected', () => {\n        browser = null;\n        browserContext = null;\n      });\n      browserContext = browser.contexts()[0] || await browser.newContext();\n      console.log(`\u5df2\u8fde\u63a5 Chrome CDP: ${CDP_URL}`);\n      return browserContext;\n    } finally {\n      connectPromise = null;\n    }\n  })();\n  return connectPromise;\n}\n\nfunction comparableUrl(value) {\n  try {\n    const url = new URL(value);\n    url.hash = '';\n    return url;\n  } catch {\n    return null;\n  }\n}\n\nasync function findOrOpenPage(context, targetUrl) {\n  const target = comparableUrl(targetUrl);\n  if (!target) throw new Error('\u8bf7\u5148\u586b\u5199\u6709\u6548\u7684\u7f51\u9875\u5bf9\u8bdd\u5730\u5740');\n  const pages = context.pages();\n  const candidates = pages.map((page) => ({ page, url: comparableUrl(page.url()) })).filter((item) => item.url);\n\n  const exact = candidates.find((item) => item.url.href === target.href);\n  if (exact) return exact.page;\n\n  const samePath = candidates.filter((item) =>\n    item.url.origin === target.origin && item.url.pathname === target.pathname\n  );\n  if (samePath.length === 1) return samePath[0].page;\n\n  const sameHost = candidates.filter((item) => item.url.hostname === target.hostname);\n  if (sameHost.length === 1) return sameHost[0].page;\n\n  const page = await context.newPage();\n  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });\n  await page.waitForTimeout(1200);\n  return page;\n}\n\nasync function firstVisibleLocator(page, selectors) {\n  for (const selector of selectors) {\n    try {\n      const locator = page.locator(selector).first();\n      if (await locator.isVisible({ timeout: 350 })) return locator;\n    } catch {\n      // A site can reject a selector; keep trying the remaining fallbacks.\n    }\n  }\n  return null;\n}\n\n// \u6a21\u62df\u771f\u5b9e\u526a\u8d34\u677f\u7c98\u8d34\u4e0e\u5355\u6b21\u6587\u672c\u5199\u5165\uff0c\u66ff\u4ee3 pressSequentially \u6beb\u79d2\u7ea7\u9ad8\u9891\u51fb\u952e\nasync function fillInput(page, input, text) {\n  try {\n    await input.fill(text, { timeout: 5000 });\n    return;\n  } catch {\n    // Rich-text editors (ProseMirror / contenteditable) often reject .fill(); use paste simulation below.\n  }\n\n  await input.click({ timeout: 5000 });\n  await input.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');\n  await input.press('Backspace');\n\n  // \u4f18\u5148\u89e6\u53d1\u6d4f\u89c8\u5668\u539f\u751f ClipboardEvent('paste') \u6216 execCommand('insertText')\uff0c\u4e0e\u4eba\u7c7b Ctrl+V \u7c98\u8d34\u884c\u4e3a\u4e00\u81f4\n  const pastedInPage = await input.evaluate((el, value) => {\n    try {\n      el.focus();\n      const dt = new DataTransfer();\n      dt.setData('text/plain', value);\n      const pasteEvent = new ClipboardEvent('paste', {\n        clipboardData: dt,\n        bubbles: true,\n        cancelable: true\n      });\n      const notCancelled = el.dispatchEvent(pasteEvent);\n      const currentText = (el.innerText || el.value || '').trim();\n      if (!notCancelled || currentText.length >= Math.min(8, value.trim().length)) {\n        return true;\n      }\n      if (document.execCommand && document.execCommand('insertText', false, value)) {\n        return true;\n      }\n    } catch {\n      // Fall through to keyboard insertText\n    }\n    return false;\n  }, text).catch(() => false);\n\n  if (!pastedInPage) {\n    await page.keyboard.insertText(text);\n  }\n}\n\nasync function captureBefore(page) {\n  return page.evaluate((selector) => {\n    const raw = Array.from(document.querySelectorAll(selector));\n    // \u8fc7\u6ee4\u5305\u542b\u5b50\u5339\u914d\u8282\u70b9\u7684\u7236\u5bb9\u5668\uff0c\u53ea\u4fdd\u7559\u6bcf\u8f6e\u72ec\u7acb\u7684\u53f6\u5b50\u52a9\u624b\u6d88\u606f\u8282\u70b9\uff0c\u675c\u7edd\u591a\u8f6e\u5386\u53f2\u5408\u5e76\n    const nodes = raw.filter((el) => !raw.some((other) => other !== el && el.contains(other)));\n    const last = nodes[nodes.length - 1];\n    const media = last ? Array.from(last.querySelectorAll('img,video')).map((item) => item.currentSrc || item.src || '').filter((src) => src && !src.startsWith('blob:')) : [];\n    const main = document.querySelector('main,[role=\"main\"]') || document.body;\n    const turnEls = Array.from(main.querySelectorAll('[data-testid*=\"conversation-turn\"], [class*=\"message\"], article'));\n    const lastTurnText = turnEls.length ? (turnEls[turnEls.length - 1].innerText?.trim() || '') : '';\n    return { count: nodes.length, text: last?.innerText?.trim() || '', mediaSignature: media.join('|'), turnCount: turnEls.length, lastTurnText };\n  }, ASSISTANT_SELECTORS);\n}\n\nasync function readLatestReply(page) {\n  return page.evaluate(([selector, genSelector]) => {\n    const genButtons = Array.from(document.querySelectorAll(genSelector));\n    const isGenerating = genButtons.some((el) => {\n      const rect = el.getBoundingClientRect();\n      return rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).display !== 'none';\n    });\n\n    const raw = Array.from(document.querySelectorAll(selector));\n    const nodes = raw.filter((el) => !raw.some((other) => other !== el && el.contains(other)));\n    const last = nodes[nodes.length - 1];\n    const main = document.querySelector('main,[role=\"main\"]') || document.body;\n    const turnEls = Array.from(main.querySelectorAll('[data-testid*=\"conversation-turn\"], [class*=\"message\"], article'));\n    const lastTurnText = turnEls.length ? (turnEls[turnEls.length - 1].innerText?.trim() || '') : '';\n    if (!last) return { count: 0, text: '', attachments: [], mediaSignature: '', turnCount: turnEls.length, lastTurnText, isGenerating };\n    const attachments = Array.from(last.querySelectorAll('img,video'))\n      .map((media, index) => ({\n        id: `web-reply-${Date.now()}-${index}`,\n        name: media.getAttribute('alt') || `\u7f51\u9875\u56de\u590d\u9644\u4ef6 ${index + 1}`,\n        type: media.tagName === 'VIDEO' ? 'video/mp4' : ('image/' + '*'),\n        url: media.currentSrc || media.src || ''\n      }))\n      .filter((item) => item.url && !item.url.startsWith('blob:'));\n    return { count: nodes.length, text: last.innerText?.trim() || '', attachments, mediaSignature: attachments.map((item) => item.url).join('|'), turnCount: turnEls.length, lastTurnText, isGenerating };\n  }, [ASSISTANT_SELECTORS, GENERATING_INDICATORS]);\n}\n\nfunction replyChanged(before, current) {\n  return current.count > before.count || current.text !== before.text ||\n    current.mediaSignature !== before.mediaSignature;\n}\n\nasync function attachFiles(page, attachments) {\n  const files = (attachments || []).filter((item) => typeof item?.url === 'string' && item.url.startsWith('data:'));\n  if (!files.length) return;\n  const prepared = files.map((file) => {\n    const match = file.url.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);\n    if (!match) return null;\n    const buffer = match[2]\n      ? Buffer.from(match[3], 'base64')\n      : Buffer.from(decodeURIComponent(match[3]), 'utf8');\n    return { name: file.name || 'chat-attachment', mimeType: file.type || match[1] || 'application/octet-stream', buffer };\n  }).filter(Boolean);\n  if (!prepared.length) return;\n  const fileInput = page.locator('input[type=\"file\"]').first();\n  if (await fileInput.count()) await fileInput.setInputFiles(prepared, { timeout: 15_000 });\n  else console.warn('\u5f53\u524d\u7f51\u9875\u6ca1\u6709\u6587\u4ef6\u4e0a\u4f20\u63a7\u4ef6\uff0c\u6d88\u606f\u6587\u672c\u5c06\u7ee7\u7eed\u53d1\u9001\uff0c\u9644\u4ef6\u672a\u6ce8\u5165\u3002');\n}\n\n// \u964d\u4f4e DOM \u626b\u63cf\u9891\u7387\uff1a\u4f7f\u7528 850ms -> 1150ms -> 1450ms \u9012\u589e\u9000\u907f\u8f6e\u8be2\u66ff\u4ee3\u56fa\u5b9a 500ms \u9ad8\u9891\u626b\u63cf\nconst POLL_BACKOFF_STEPS_MS = [850, 1050, 1250, 1450];\n\nasync function sendPrompt(page, command) {\n  const configuredInput = command.selectorInput ? [command.selectorInput, ...INPUT_FALLBACKS] : INPUT_FALLBACKS;\n  const input = await firstVisibleLocator(page, [...new Set(configuredInput)]);\n  if (!input) throw new Error('\u6ca1\u627e\u5230\u53ef\u89c1\u8f93\u5165\u6846\uff1b\u8bf7\u786e\u8ba4\u7f51\u9875\u5df2\u767b\u5f55\uff0c\u6216\u4fee\u6539\u804a\u5929\u4eba\u7684\u8f93\u5165\u6846\u9009\u62e9\u5668');\n\n  const before = await captureBefore(page);\n  await input.click({ timeout: 8000 });\n  await fillInput(page, input, command.payload || '');\n  await attachFiles(page, command.attachments);\n  await page.waitForTimeout(300);\n\n  let sent = false;\n  const sendSelectors = command.selectorSend ? [command.selectorSend, ...SEND_FALLBACKS] : SEND_FALLBACKS;\n  const sendButton = await firstVisibleLocator(page, [...new Set(sendSelectors)]);\n  if (sendButton && await sendButton.isEnabled().catch(() => false)) {\n    await sendButton.click({ timeout: 5000 });\n    sent = true;\n  }\n  if (!sent) await input.press('Enter', { timeout: 5000 });\n  console.log(`\u5df2\u5411 ${command.botId || '\u7f51\u9875 AI'} \u63d0\u4ea4\u6d88\u606f\uff0c\u7b49\u5f85\u65b0\u56de\u590d\u2026`);\n\n  const deadline = Date.now() + REPLY_TIMEOUT_MS;\n  let previousSignature = '';\n  let stableTicks = 0;\n  let pollStep = 0;\n  let lastReply = null;\n  while (Date.now() < deadline) {\n    const intervalMs = POLL_BACKOFF_STEPS_MS[Math.min(pollStep, POLL_BACKOFF_STEPS_MS.length - 1)];\n    pollStep += 1;\n    await page.waitForTimeout(intervalMs);\n    const current = await readLatestReply(page);\n\n    // \u5173\u952e\u4fee\u590d\uff1a\u68c0\u6d4b\u5230\u7f51\u9875 AI \u4ecd\u5728\u601d\u8003\u6216\u6d41\u5f0f\u8f93\u51fa\u4e2d\uff08\u5b58\u5728 Stop \u6309\u94ae\uff09\uff0c\u4fdd\u6301\u7b49\u5f85\u7edd\u4e0d\u63d0\u524d\u622a\u65ad\n    if (current.isGenerating) {\n      stableTicks = 0;\n      previousSignature = '';\n      lastReply = current;\n      continue;\n    }\n\n    // \u4fee\u590d ChatGPT \u62fc\u63a5\u524d\u51e0\u8f6e\u5386\u53f2\u56de\u590d\u7684 Bug\uff1a\u7edd\u4e0d\u4f7f\u7528 slice(-8) \u62fc\u63a5\u5386\u53f2\u6bb5\u843d\uff0c\u53ea\u8bfb\u53d6\u6700\u540e\u4e00\u4e2a\u5bf9\u8bdd\u56de\u5408\u7684\u65b0\u589e\u5185\u5bb9\n    if ((!current.text || current.text === before.text) && current.turnCount > before.turnCount && current.lastTurnText && current.lastTurnText !== before.lastTurnText) {\n      const cleaned = current.lastTurnText.replace(/^(ChatGPT|Assistant|DeepSeek|Claude|Kimi)\\s*[:\uff1a]?\\s*/i, '').trim();\n      if (cleaned && cleaned !== (command.payload || '').trim()) current.text = cleaned;\n    }\n    if (current.text === (command.payload || '').trim()) continue;\n    if (!replyChanged(before, current)) continue;\n    const signature = `${current.count}|${current.text}|${current.attachments.map((file) => file.url).join('|')}`;\n    if (signature === previousSignature) stableTicks += 1;\n    else {\n      previousSignature = signature;\n      stableTicks = 0;\n    }\n    lastReply = current;\n    // \u786e\u4fdd\u751f\u6210\u5b8c\u6bd5\u4e14\u8fde\u7eed 3 \u6b21\u68c0\u6d4b\uff08\u81f3\u5c11 3 \u79d2\uff09\u65e0\u53d8\u5316\uff0c\u4fdd\u8bc1\u957f\u56de\u7b54\u5b8c\u6574\u6355\u83b7\n    if (stableTicks >= 3 && (current.text || current.attachments.length)) return current;\n  }\n  if (!lastReply) throw new Error('\u7b49\u5f85\u7f51\u9875 AI \u56de\u590d\u8d85\u65f6\uff1b\u8bf7\u68c0\u67e5\u76ee\u6807\u6807\u7b7e\u9875\u662f\u5426\u5df2\u767b\u5f55\u5e76\u6b63\u5e38\u54cd\u5e94');\n  throw new Error('\u7f51\u9875\u751f\u6210\u65f6\u95f4\u8fc7\u957f\uff0c\u672a\u89c2\u5bdf\u5230\u8fde\u7eed\u7a33\u5b9a\u7684\u5b8c\u6574\u65b0\u56de\u590d\uff1b\u8bf7\u68c0\u67e5\u76ee\u6807\u9875\u9762\u72b6\u6001\u540e\u91cd\u8bd5');\n}\n\nasync function processCommand(ws, command) {\n  if (!command.targetUrl) throw new Error('\u8bf7\u5148\u586b\u5199\u8be5\u804a\u5929\u4eba\u7684\u7f51\u9875\u5bf9\u8bdd\u5730\u5740');\n  const context = await getContext();\n  const page = await findOrOpenPage(context, command.targetUrl);\n  await page.bringToFront();\n  const reply = await sendPrompt(page, command);\n  send(ws, {\n    type: 'BOT_REPLY', botId: command.botId, groupId: command.groupId,\n    requestId: command.requestId, syncThrough: command.syncThrough,\n    text: reply.text, attachments: reply.attachments, deltaPayload: command.payload || ''\n  });\n  console.log(`\u6536\u5230 ${command.botId || '\u7f51\u9875 AI'} \u65b0\u56de\u590d\uff08${reply.text.length} \u5b57\uff09\u3002`);\n}\n\nawait loadSavedState();\nconst wss = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1', maxPayload: 512 * 1024 * 1024 });\nconsole.log(`Chat H \u6865\u63a5\u5df2\u542f\u52a8\uff1aws://127.0.0.1:${WS_PORT}`);\nconsole.log(`\u72b6\u6001\u6587\u4ef6\uff1a${STATE_FILE}`);\n\nwss.on('connection', (ws) => {\n  console.log('Chat H \u5ba2\u6237\u7aef\u5df2\u8fde\u63a5\u3002');\n  send(ws, { type: 'LOAD_STATE', payload: savedState });\n  ws.on('message', (raw) => {\n    let command;\n    try { command = JSON.parse(raw.toString()); }\n    catch { send(ws, { type: 'BOT_ERROR', message: '\u6865\u63a5\u6536\u5230\u65e0\u6cd5\u89e3\u6790\u7684\u6d88\u606f' }); return; }\n\n    if (command.action === 'SAVE_STATE') {\n      if (!command.payload || typeof command.payload !== 'object') return;\n      if (savedState && (command.payload.savedAt || 0) <= (savedState.savedAt || 0)) return;\n      saveState(command.payload)\n        .then(() => console.log('\u72b6\u6001\u5df2\u5199\u5165 web_h_userdata.json\u3002'))\n        .catch((error) => console.error('\u72b6\u6001\u4fdd\u5b58\u5931\u8d25\uff1a', error.message));\n      return;\n    }\n    if (command.action !== 'SEND_TO_TAB') return;\n\n    const queueKey = (() => {\n      try {\n        const target = new URL(command.targetUrl);\n        return `${target.origin}${target.pathname}`;\n      } catch {\n        return command.botId || 'unknown';\n      }\n    })();\n    const previous = taskQueues.get(queueKey) || Promise.resolve();\n    const next = previous\n      .catch(() => {})\n      .then(() => processCommand(ws, command))\n      .catch((error) => replyError(ws, command, error));\n    taskQueues.set(queueKey, next);\n    next.finally(() => {\n      if (taskQueues.get(queueKey) === next) taskQueues.delete(queueKey);\n    });\n  });\n  ws.on('error', (error) => console.warn('WebSocket \u8fde\u63a5\u5f02\u5e38\uff1a', error.message));\n});\n\nwss.on('error', (error) => {\n  console.error(`\u6865\u63a5 WebSocket \u65e0\u6cd5\u76d1\u542c 127.0.0.1:${WS_PORT}\uff1a${error.message}`);\n  process.exitCode = 1;\n});";
const {
  MessageSquare,
  Settings,
  Terminal,
  Plus,
  Sparkles,
  Link2,
  CheckCircle2,
  RefreshCw,
  Copy,
  Check,
  Sliders,
  Eye,
  ChevronRight,
  ChevronDown,
  Cpu,
  Wifi,
  Code2,
  Sun,
  Moon,
  Layers,
  Search,
  ArrowUp,
  PanelRight,
  PanelLeft,
  Flame,
  Radio,
  X,
  Palette,
  Upload,
  RotateCcw,
  Video,
  Trash2,
  Pencil,
  Quote,
  Download,
  Minus,
  ChevronLeft,
  CornerUpRight,
  Share2,
  Pin,
  Globe,
  Smartphone,
  Monitor,
  ExternalLink,
  SplitSquareVertical,
  ShieldCheck,
  Play,
  Send,
  Maximize2,
  Minimize2
} = window.LucideIcons;
const ANDROID_NATIVE_BRIDGE_SOURCE = "package com.webh.aiwechat\n\nimport android.annotation.SuppressLint\nimport android.os.Bundle\nimport android.view.View\nimport android.view.ViewGroup\nimport android.webkit.CookieManager\nimport android.webkit.JavascriptInterface\nimport android.webkit.WebChromeClient\nimport android.webkit.WebResourceRequest\nimport android.webkit.WebSettings\nimport android.webkit.WebView\nimport android.webkit.WebViewClient\nimport android.widget.FrameLayout\nimport androidx.activity.ComponentActivity\nimport androidx.activity.OnBackPressedCallback\nimport org.json.JSONObject\nimport java.util.concurrent.ConcurrentHashMap\n\n/**\n * Chat H (OmniChat) \u5b89\u5353\u624b\u673a\u539f\u751f\u5bbf\u4e3b\u5bb9\u5668\n * \u67b6\u6784\u7279\u70b9\uff1a\n * 1. \u4e3b\u754c\u9762 WebView (mainWebView) \u627f\u8f7d\u7fa4\u804a\u3001\u7075\u52a8\u5c9b\u3001\u5206\u5c4f\u63a7\u5236\u4e0e\u8bbe\u7f6e UI\n * 2. \u5e94\u7528\u5185\u5d4c\u591a\u6807\u7b7e AI WebView \u5bb9\u5668\u6c60 (aiWebViewPool: Map<botId, WebView>) \u76f4\u63a5\u5d4c\u5957\u5728\u5e94\u7528\u5185\u90e8\n * 3. \u901a\u8fc7 @JavascriptInterface (window.AndroidWebHBridge) \u96f6\u5ef6\u8fdf\u5c06\u589e\u91cf\u63d0\u793a\u8bcd\u6ce8\u5165\u5230\u6307\u5b9a AI \u7684\u5185\u5d4c WebView\uff0c\n *    \u5b8c\u5168\u66ff\u4ee3 PC \u7aef\u7e41\u7410\u7684 Playwright + Chrome CDP 9222 \u7aef\u53e3\u65b9\u6848\uff0c\u4e14\u5171\u4eab\u6301\u4e45\u5316\u767b\u5f55 Cookie\uff01\n */\nclass MainActivity : ComponentActivity() {\n\n    private lateinit var rootContainer: FrameLayout\n    private lateinit var mainWebView: WebView\n    private lateinit var embeddedBrowserSlot: FrameLayout\n    private val aiWebViewPool = ConcurrentHashMap<String, WebView>()\n    private var activeVisibleBotId: String? = null\n    private lateinit var injectorScript: String\n\n    @SuppressLint(\"SetJavaScriptEnabled\")\n    override fun onCreate(savedInstanceState: Bundle?) {\n        super.onCreate(savedInstanceState)\n\n        injectorScript = assets.open(\"web_h_injector.js\").bufferedReader().use { it.readText() }\n\n        rootContainer = FrameLayout(this).apply {\n            layoutParams = ViewGroup.LayoutParams(\n                ViewGroup.LayoutParams.MATCH_PARENT,\n                ViewGroup.LayoutParams.MATCH_PARENT\n            )\n        }\n\n        // 1. \u4e3b\u754c\u9762 WebView (React \u7fa4\u804a + \u7075\u52a8\u5c9b + \u63a7\u5236\u4e2d\u5fc3)\n        mainWebView = WebView(this).apply {\n            layoutParams = FrameLayout.LayoutParams(\n                ViewGroup.LayoutParams.MATCH_PARENT,\n                ViewGroup.LayoutParams.MATCH_PARENT\n            )\n            configureWebSettings(settings, isDesktopUA = false)\n            addJavascriptInterface(MainUiBridge(), \"AndroidWebHBridge\")\n            webChromeClient = WebChromeClient()\n            webViewClient = WebViewClient()\n            loadUrl(\"file:///android_asset/www/index.html\")\n        }\n\n        // 2. \u5e94\u7528\u5185\u5d4c AI \u6d4f\u89c8\u5668\u6302\u8f7d\u5c42 (\u652f\u6301\u5168\u5c4f\u5185\u5d4c\u6216\u4e0a\u4e0b\u540c\u5c4f\u5206\u5c4f\u663e\u793a\u771f\u5b9e AI \u7f51\u9875)\n        embeddedBrowserSlot = FrameLayout(this).apply {\n            layoutParams = FrameLayout.LayoutParams(\n                ViewGroup.LayoutParams.MATCH_PARENT,\n                ViewGroup.LayoutParams.MATCH_PARENT\n            )\n            visibility = View.GONE\n        }\n\n        rootContainer.addView(mainWebView)\n        rootContainer.addView(embeddedBrowserSlot)\n        setContentView(rootContainer)\n\n        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {\n            override fun handleOnBackPressed() {\n                val botId = activeVisibleBotId\n                val activeAiWebView = if (botId != null) aiWebViewPool[botId] else null\n                if (embeddedBrowserSlot.visibility == View.VISIBLE && activeAiWebView?.canGoBack() == true) {\n                    activeAiWebView.goBack()\n                } else if (mainWebView.canGoBack()) {\n                    mainWebView.goBack()\n                } else {\n                    finish()\n                }\n            }\n        })\n    }\n\n    @SuppressLint(\"SetJavaScriptEnabled\")\n    private fun configureWebSettings(settings: WebSettings, isDesktopUA: Boolean) {\n        settings.javaScriptEnabled = true\n        settings.domStorageEnabled = true\n        settings.databaseEnabled = true\n        settings.mediaPlaybackRequiresUserGesture = false\n        settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW\n        settings.userAgentString = if (isDesktopUA) {\n            \"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36\"\n        } else {\n            \"Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36\"\n        }\n    }\n\n    @SuppressLint(\"SetJavaScriptEnabled\")\n    private fun getOrCreateAiWebView(botId: String, targetUrl: String): WebView {\n        return aiWebViewPool.getOrPut(botId) {\n            WebView(this).apply {\n                layoutParams = FrameLayout.LayoutParams(\n                    ViewGroup.LayoutParams.MATCH_PARENT,\n                    ViewGroup.LayoutParams.MATCH_PARENT\n                )\n                configureWebSettings(settings, isDesktopUA = false)\n                CookieManager.getInstance().setAcceptCookie(true)\n                CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)\n                addJavascriptInterface(AiPageHostBridge(botId), \"AndroidWebHHost\")\n                webChromeClient = WebChromeClient()\n                webViewClient = object : WebViewClient() {\n                    override fun onPageFinished(view: WebView?, url: String?) {\n                        super.onPageFinished(view, url)\n                        CookieManager.getInstance().flush()\n                        view?.evaluateJavascript(injectorScript, null)\n                        notifyMainUi(\n                            JSONObject().apply {\n                                put(\"type\", \"WEBVIEW_URL_CHANGED\")\n                                put(\"botId\", botId)\n                                put(\"url\", url ?: targetUrl)\n                            }.toString()\n                        )\n                    }\n\n                    override fun shouldOverrideUrlLoading(\n                        view: WebView?,\n                        request: WebResourceRequest?\n                    ): Boolean = false\n                }\n                if (targetUrl.isNotBlank()) {\n                    loadUrl(targetUrl)\n                }\n            }\n        }\n    }\n\n    private fun notifyMainUi(jsonPayload: String) {\n        runOnUiThread {\n            val escaped = JSONObject.quote(jsonPayload)\n            mainWebView.evaluateJavascript(\n                \"window.__onAndroidBridgeEvent && window.__onAndroidBridgeEvent($escaped);\",\n                null\n            )\n        }\n    }\n\n    inner class MainUiBridge {\n        @JavascriptInterface\n        fun postCommand(rawJson: String) {\n            runOnUiThread {\n                try {\n                    val cmd = JSONObject(rawJson)\n                    when (cmd.optString(\"action\")) {\n                        \"SEND_TO_TAB\" -> {\n                            val botId = cmd.optString(\"botId\", \"deepseek\")\n                            val targetUrl = cmd.optString(\"targetUrl\", \"\")\n                            val webView = getOrCreateAiWebView(botId, targetUrl)\n                            if (targetUrl.isNotBlank() && webView.url.isNullOrBlank()) {\n                                webView.loadUrl(targetUrl)\n                            }\n                            webView.evaluateJavascript(injectorScript) {\n                                webView.evaluateJavascript(\n                                    \"window.__webHExecuteCommand && window.__webHExecuteCommand($rawJson);\",\n                                    null\n                                )\n                            }\n                        }\n                        \"SHOW_EMBEDDED_WEBVIEW\" -> {\n                            val botId = cmd.optString(\"botId\", \"deepseek\")\n                            val targetUrl = cmd.optString(\"targetUrl\", \"\")\n                            val topPx = cmd.optInt(\"topPx\", 140)\n                            val heightPx = cmd.optInt(\"heightPx\", -1)\n                            val webView = getOrCreateAiWebView(botId, targetUrl)\n                            embeddedBrowserSlot.removeAllViews()\n                            (webView.parent as? ViewGroup)?.removeView(webView)\n                            embeddedBrowserSlot.layoutParams = FrameLayout.LayoutParams(\n                                ViewGroup.LayoutParams.MATCH_PARENT,\n                                if (heightPx > 0) heightPx else ViewGroup.LayoutParams.MATCH_PARENT\n                            ).apply {\n                                topMargin = topPx\n                            }\n                            embeddedBrowserSlot.addView(webView)\n                            embeddedBrowserSlot.visibility = View.VISIBLE\n                            activeVisibleBotId = botId\n                        }\n                        \"HIDE_EMBEDDED_WEBVIEW\" -> {\n                            embeddedBrowserSlot.visibility = View.GONE\n                            activeVisibleBotId = null\n                        }\n                        \"RELOAD_WEBVIEW\" -> {\n                            val botId = cmd.optString(\"botId\", \"deepseek\")\n                            aiWebViewPool[botId]?.reload()\n                        }\n                        \"NAVIGATE_WEBVIEW\" -> {\n                            val botId = cmd.optString(\"botId\", \"deepseek\")\n                            val url = cmd.optString(\"targetUrl\", \"\")\n                            val webView = getOrCreateAiWebView(botId, url)\n                            if (url.isNotBlank()) webView.loadUrl(url)\n                        }\n                    }\n                } catch (e: Exception) {\n                    notifyMainUi(\n                        JSONObject().apply {\n                            put(\"type\", \"BOT_ERROR\")\n                            put(\"message\", \"Android \u539f\u751f\u6865\u63a5\u5f02\u5e38: ${e.message}\")\n                        }.toString()\n                    )\n                }\n            }\n        }\n    }\n\n    inner class AiPageHostBridge(private val botId: String) {\n        @JavascriptInterface\n        fun onBridgeEvent(rawJson: String) {\n            notifyMainUi(rawJson)\n        }\n    }\n}\n\n\n// ===== assets/web_h_injector.js =====\n/**\n * Chat H (OmniChat) Android In-App WebView DOM Injector\n * \u76f4\u63a5\u6ce8\u5165\u5728\u5e94\u7528\u5185\u5d4c\u7684\u5404\u4e2a AI \u7f51\u9875 WebView \u4e2d\uff0c\u65e0\u9700\u5916\u90e8 Chrome CDP \u6216 PC \u670d\u52a1\u5668\u3002\n * \u901a\u8fc7 window.AndroidWebHHost \u4e0e\u4e3b\u754c\u9762 React WebView \u96f6\u5ef6\u8fdf\u5185\u5b58\u901a\u4fe1\u3002\n */\n(function () {\n  if (window.__WEB_H_INJECTOR_INSTALLED__) return;\n  window.__WEB_H_INJECTOR_INSTALLED__ = true;\n\n  const INPUT_FALLBACKS = [\n    '#chat-input',\n    '#prompt-textarea',\n    'div.ProseMirror[contenteditable=\"true\"]',\n    'rich-textarea div[contenteditable=\"true\"]',\n    '[contenteditable=\"true\"]',\n    'textarea:not([disabled]):not(#pending-conversation-input)',\n    '[role=\"textbox\"]',\n    'input[type=\"text\"]'\n  ];\n\n  const SEND_FALLBACKS = [\n    'button[data-testid=\"send-button\"]',\n    'div[role=\"button\"].ds-send-btn',\n    'button[aria-label*=\"Send\"]',\n    'button[aria-label*=\"\u53d1\u9001\"]',\n    'button.send-button',\n    'button[type=\"submit\"]',\n    '[role=\"button\"][aria-label*=\"Send\"]',\n    '[role=\"button\"][aria-label*=\"\u53d1\u9001\"]'\n  ];\n\n  const ASSISTANT_SELECTORS = [\n    '[data-message-author-role=\"assistant\"] div.markdown',\n    '[data-message-author-role=\"assistant\"]',\n    '[data-testid*=\"conversation-turn\"] [data-message-author-role=\"assistant\"]',\n    '.ds-markdown',\n    '.font-claude-message',\n    'message-content',\n    '[class*=\"assistant\"] .markdown-body',\n    '[data-testid*=\"assistant-message\"]',\n    '.markdown-body',\n    '.prose'\n  ].join(',');\n\n  const GENERATING_INDICATORS = [\n    'button[data-testid=\"stop-button\"]',\n    'button[aria-label*=\"Stop\"]',\n    'button[aria-label*=\"\u505c\u6b62\"]',\n    'button[aria-label*=\"Cancel\"]',\n    'button.ds-stop-btn',\n    '.result-thinking',\n    '.streaming',\n    '[data-testid*=\"stop\"]'\n  ].join(',');\n\n  function isVisible(el) {\n    if (!el) return false;\n    const rect = el.getBoundingClientRect();\n    const style = window.getComputedStyle(el);\n    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';\n  }\n\n  function findFirstVisible(selectors) {\n    for (const sel of selectors) {\n      if (!sel) continue;\n      try {\n        const list = Array.from(document.querySelectorAll(sel));\n        const found = list.find(isVisible);\n        if (found) return found;\n      } catch (_e) {}\n    }\n    return null;\n  }\n\n  function getLeafAssistantNodes() {\n    const raw = Array.from(document.querySelectorAll(ASSISTANT_SELECTORS));\n    return raw.filter((el) => !raw.some((other) => other !== el && el.contains(other)));\n  }\n\n  function isPageGenerating() {\n    const els = Array.from(document.querySelectorAll(GENERATING_INDICATORS));\n    return els.some(isVisible);\n  }\n\n  function setNativeInputValue(el, text) {\n    el.focus();\n    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {\n      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;\n      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;\n      if (setter) setter.call(el, text);\n      else el.value = text;\n      el.dispatchEvent(new Event('input', { bubbles: true }));\n      el.dispatchEvent(new Event('change', { bubbles: true }));\n      return true;\n    }\n    try {\n      const selection = window.getSelection();\n      const range = document.createRange();\n      range.selectNodeContents(el);\n      selection.removeAllRanges();\n      selection.addRange(range);\n      if (!document.execCommand('insertText', false, text)) {\n        el.innerText = text;\n      }\n      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: text }));\n      return true;\n    } catch (_e) {\n      el.innerText = text;\n      el.dispatchEvent(new Event('input', { bubbles: true }));\n      return true;\n    }\n  }\n\n  window.__webHExecuteCommand = async function (command) {\n    const emit = (payload) => {\n      if (window.AndroidWebHHost && typeof window.AndroidWebHHost.onBridgeEvent === 'function') {\n        window.AndroidWebHHost.onBridgeEvent(JSON.stringify(payload));\n      } else if (window.parent && window.parent !== window) {\n        window.parent.postMessage({ __webHBridge: true, payload }, '*');\n      }\n    };\n\n    try {\n      const inputSelectors = command.selectorInput ? [command.selectorInput, ...INPUT_FALLBACKS] : INPUT_FALLBACKS;\n      const inputEl = findFirstVisible(inputSelectors);\n      if (!inputEl) {\n        throw new Error('\u6ca1\u627e\u5230\u53ef\u89c1\u8f93\u5165\u6846\uff1b\u8bf7\u5728\u8be5 AI \u7684\u5e94\u7528\u5185\u5d4c\u7f51\u9875\u4e2d\u786e\u8ba4\u5df2\u767b\u5f55');\n      }\n\n      const beforeNodes = getLeafAssistantNodes();\n      const beforeCount = beforeNodes.length;\n      const beforeLastText = beforeCount > 0 ? (beforeNodes[beforeCount - 1].innerText || '').trim() : '';\n\n      setNativeInputValue(inputEl, command.payload || '');\n      await new Promise((r) => setTimeout(r, 260));\n\n      const sendSelectors = command.selectorSend ? [command.selectorSend, ...SEND_FALLBACKS] : SEND_FALLBACKS;\n      const sendBtn = findFirstVisible(sendSelectors);\n      if (sendBtn && !sendBtn.disabled) {\n        sendBtn.click();\n      } else {\n        inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));\n      }\n\n      const startTime = Date.now();\n      let firstTokenSent = false;\n      let firstSentenceSent = false;\n      let previousText = '';\n      let stableTicks = 0;\n\n      while (Date.now() - startTime < 90000) {\n        await new Promise((r) => setTimeout(r, 750));\n        const nodes = getLeafAssistantNodes();\n        const lastNode = nodes[nodes.length - 1];\n        const currentText = lastNode ? (lastNode.innerText || '').trim() : '';\n        const hasNewReply = nodes.length > beforeCount || (currentText && currentText !== beforeLastText && currentText !== (command.payload || '').trim());\n\n        if (hasNewReply && currentText) {\n          if (!firstTokenSent) {\n            firstTokenSent = true;\n            emit({ type: 'BOT_PROGRESS', phase: 'first-token', botId: command.botId, groupId: command.groupId, requestId: command.requestId, text: currentText });\n          }\n          if (!firstSentenceSent && /[\u3002\uff01\uff1f.!?\\n]/.test(currentText)) {\n            firstSentenceSent = true;\n            emit({ type: 'BOT_PROGRESS', phase: 'first-sentence', botId: command.botId, groupId: command.groupId, requestId: command.requestId, text: currentText });\n          }\n        }\n\n        if (isPageGenerating()) {\n          stableTicks = 0;\n          previousText = currentText;\n          continue;\n        }\n\n        if (hasNewReply && currentText) {\n          if (currentText === previousText) {\n            stableTicks += 1;\n          } else {\n            previousText = currentText;\n            stableTicks = 0;\n          }\n          if (stableTicks >= 2) {\n            emit({\n              type: 'BOT_REPLY',\n              botId: command.botId,\n              groupId: command.groupId,\n              requestId: command.requestId,\n              syncThrough: command.syncThrough,\n              text: currentText,\n              attachments: [],\n              deltaPayload: command.payload || ''\n            });\n            return;\n          }\n        }\n      }\n      throw new Error('\u7b49\u5f85\u5e94\u7528\u5185\u5d4c AI \u7f51\u9875\u56de\u590d\u8d85\u65f6\uff0c\u8bf7\u6253\u5f00\u300c\u5185\u5d4c\u7f51\u9875\u300d\u6807\u7b7e\u68c0\u67e5\u9875\u9762\u72b6\u6001');\n    } catch (err) {\n      emit({\n        type: 'BOT_ERROR',\n        botId: command.botId,\n        groupId: command.groupId,\n        requestId: command.requestId,\n        syncThrough: command.syncThrough,\n        message: err && err.message ? err.message : String(err)\n      });\n    }\n  };\n})();\n";
const INITIAL_BOTS = [{
  id: 'deepseek',
  name: 'DeepSeek R1',
  roleTag: '毒舌首席架构师',
  platform: 'DeepSeek Web',
  avatarBg: 'from-[#0052FF] via-[#0080FF] to-[#4F46E5]',
  ringColor: 'ring-blue-400/50',
  dotColor: 'bg-[#0080FF] shadow-[0_0_8px_#0080FF]',
  badge: 'DS',
  targetUrl: 'https://chat.deepseek.com/',
  selectorInput: '#chat-input',
  selectorSend: 'div[role="button"].ds-send-btn',
  status: 'connected',
  persona: '一针见血的十年老架构师，极其反感正确的废话和形式主义。说话带点冷幽默和吐槽，每次发言绝不超过2句话，喜欢直接指出别人方案里的致命漏洞。',
  syncCursor: 3,
  SampleReplies: ['别整那些虚头巴脑的，你这方案并发一上来数据库直接原地爆炸，信不信？', '楼上Kimi说的听着挺美，谁来写底层维护？最后还不是得靠加机器硬扛。', '行了，直接上 SQLite 加本地缓存先跑通 MVP，别一上来就微服务架构。', '这需求我五年前就见过，最后砍得只剩一个按钮，听我一句劝，怎么省事怎么来。']
}, {
  id: 'chatgpt',
  name: 'ChatGPT 4o',
  roleTag: '硅谷增长产品狂',
  platform: 'ChatGPT Web',
  avatarBg: 'from-[#10A37F] via-[#059669] to-[#06B6D4]',
  ringColor: 'ring-emerald-400/50',
  dotColor: 'bg-[#10A37F] shadow-[0_0_8px_#10A37F]',
  badge: '4o',
  targetUrl: 'https://chatgpt.com/',
  selectorInput: '#prompt-textarea',
  selectorSend: 'button[data-testid="send-button"]',
  status: 'connected',
  persona: '激进的独立开发者兼产品经理，满脑子增长黑客和用户体验，讨厌端着架子说教。说话快言快语，喜欢反问和拍板，直接跟楼上互怼。',
  syncCursor: 3,
  SampleReplies: ['老哥别太悲观！用户根本不在乎你底层用啥，第一眼不够惊艳 3 秒就关掉了好吗！', '我同意先把架子搭起来，但动效和毛玻璃质感必须拉满，不然发到推特上根本没人转。', '要不咱们干脆砍掉注册登录，打开网页直接就能拉群聊，留存率绝对翻倍！', 'DeepSeek 你每次都泼冷水，那你给个今晚就能跑通的痛快方案啊？']
}, {
  id: 'kimi',
  name: 'Kimi K2',
  roleTag: '吃瓜冲浪情报员',
  platform: 'Kimi Web',
  avatarBg: 'from-[#9333EA] via-[#D946EF] to-[#F43F5E]',
  ringColor: 'ring-fuchsia-400/50',
  dotColor: 'bg-[#D946EF] shadow-[0_0_8px_#D946EF]',
  badge: 'Ki',
  targetUrl: 'https://www.kimi.com/',
  selectorInput: 'div[contenteditable="true"].chat-input',
  selectorSend: 'button.send-button',
  status: 'connected',
  persona: '网速极快的冲浪达人，擅长扒竞品黑料和网感吐槽。绝不列123点，说话像真人在群里八卦一样接地气。',
  syncCursor: 2,
  SampleReplies: ['哈哈哈哈你们俩别吵了，隔壁刚有个团队做了一模一样的东西，因为UI太丑被喷惨了！', '真的假的？我刚去翻了下 GitHub，现在高玩都在用 CDP 挂载本地浏览器搞这套了。', '有一说一，4o 说的免登录确实爽，我自己看到扫码弹窗就直接右上角点叉。', '算我一个！只要别让我手写正则和调老旧 CSS，干啥都行~']
}, {
  id: 'claude',
  name: 'Claude 3.7',
  roleTag: 'Apple 设计强迫症',
  platform: 'Claude Web',
  avatarBg: 'from-[#EA580C] via-[#F97316] to-[#FB923C]',
  ringColor: 'ring-orange-400/50',
  dotColor: 'bg-[#F97316] shadow-[0_0_8px_#F97316]',
  badge: 'CL',
  targetUrl: 'https://claude.ai/new',
  selectorInput: 'div.ProseMirror[contenteditable="true"]',
  selectorSend: 'button[aria-label="Send Message"]',
  status: 'connected',
  persona: '审美极高、对 macOS 交互手感和代码洁癖有执念的设计极客。说话简短毒舌，专门挑别人逻辑和视觉细节上的刺，绝不说套话。',
  syncCursor: 1,
  SampleReplies: ['把顶部所有杂乱胶囊全部收进这一颗 Apple 灵动岛里，平时只留一条呼吸态，点开才切视角和模式，这下彻底干净了！', '刚才测了下，只要把提示词尾巴加上 50 字限制，网页流式吐字的速度立马快了三倍。', '同意 DeepSeek，越克制的设计越耐看，多余的分割线全用微光留白替代。', '你们聊归聊，记得把 DOM 监听器的防抖开了，丝滑度直接拉到 120 帧。']
}];
const INITIAL_MESSAGES = [{
  id: 1,
  senderId: 'me',
  senderName: '我 (主理人)',
  text: '各位，我把顶部所有开关和视角切换器全部收进中央那颗「Apple 灵动岛」里了！平时只是一条极简胶囊，有重要同步消息自动流体展开，主动点击才弹出控制面板。',
  date: '2026-11-02',
  time: '18:48',
  syncedTo: ['deepseek', 'chatgpt', 'kimi', 'claude']
}, {
  id: 2,
  senderId: 'deepseek',
  senderName: 'DeepSeek R1',
  text: '千万别每次把整个聊天记录重发一遍！本地维护一个游标（syncCursor），每次只把某个 AI 没看过的增量新消息塞进它的网页输入框，响应直接起飞。',
  date: '2026-11-02',
  time: '18:49',
  syncedTo: ['deepseek', 'chatgpt', 'kimi'],
  deltaPayload: '[我 (主理人)]: 各位，我把顶部所有开关和视角切换器全部收进中央那颗「Apple 灵动岛」里了！平时只是一条极简胶囊，有重要同步消息自动流体展开，主动点击才弹出控制面板。\n\n(记住：用1-2句大白话直接接话，严禁分点列举和说教)'
}, {
  id: 3,
  senderId: 'chatgpt',
  senderName: 'ChatGPT 4o',
  text: '这颗灵动岛太丝滑了！平时完全不挡视线，谁在网页端输入或者有重要通知时才会动态变宽提醒，点一下就能切模式，简直绝配！',
  date: '2026-11-03',
  time: '18:49',
  syncedTo: ['deepseek', 'chatgpt'],
  deltaPayload: '[我 (主理人)]: 各位，我把顶部所有开关和视角切换器全部收进中央那颗「Apple 灵动岛」里了！平时只是一条极简胶囊，有重要同步消息自动流体展开，主动点击才弹出控制面板。\n[DeepSeek R1]: 千万别每次把整个聊天记录重发一遍！本地维护一个游标（syncCursor），每次只把某个 AI 没看过的增量新消息塞进它的网页输入框，响应直接起飞。\n\n(记住：用1-2句大白话直接接话，严禁分点列举和说教)'
}];
const GROUPS = [{
  id: 'group-1',
  name: 'AI 核心架构研讨室',
  subtitle: '4 个网页模型在线 · 增量流式同步',
  time: '18:49',
  unread: 0,
  active: true,
  memberIds: ['deepseek', 'chatgpt', 'kimi', 'claude']
}, {
  id: 'group-2',
  name: '独立产品毒舌评审团',
  subtitle: 'DeepSeek: 中式恐怖早烂大街了...',
  time: '16:42',
  unread: 2,
  active: false,
  memberIds: ['deepseek', 'chatgpt', 'kimi']
}, {
  id: 'group-3',
  name: 'Apple 审美与代码洁癖群',
  subtitle: 'Claude: 圆角曲率必须用连续平滑曲线',
  time: '昨天',
  unread: 0,
  active: false,
  memberIds: ['chatgpt', 'claude']
}];
const ISLAND_PRESETS = [{
  id: 'obsidian',
  name: '暗夜曜石钛金',
  desc: 'Apple 钛金暗夜高光流体微光',
  isLight: false,
  subtle: {
    bgClass: 'bg-[#0B0C10]/95 text-white border-white/[0.12] shadow-black/35',
    previewBg: 'linear-gradient(135deg, #0B0C10, #181A22)'
  },
  balanced: {
    bgClass: 'bg-gradient-to-r from-[#0b0f19] via-[#161c2d] to-[#0c101b] text-white border-white/[0.18] shadow-[0_10px_35px_rgba(15,23,42,0.6)]',
    previewBg: 'linear-gradient(135deg, #0b0f19 0%, #1f273d 50%, #0c101b 100%)'
  },
  vibrant: {
    bgClass: 'bg-gradient-to-r from-[#0b0f19] via-[#1e2640] to-[#0d111a] text-white border-indigo-400/40 shadow-[0_12px_40px_rgba(15,23,42,0.9)]',
    previewBg: 'linear-gradient(135deg, #0b0f19 0%, #293556 50%, #0d111a 100%)'
  }
}, {
  id: 'glacier-light',
  name: '冰川极光透白',
  desc: '高透冰川极光双色毛玻璃',
  isLight: true,
  subtle: {
    bgClass: 'bg-white/95 text-zinc-900 border-zinc-300/90 shadow-zinc-300/50',
    previewBg: 'linear-gradient(135deg, #FFFFFF, #E4E8F0)'
  },
  balanced: {
    bgClass: 'bg-gradient-to-r from-white/95 via-sky-50/90 to-indigo-50/90 text-zinc-900 border-sky-200/90 shadow-[0_10px_30px_rgba(56,189,248,0.2)]',
    previewBg: 'linear-gradient(135deg, #ffffff 0%, #e0f2fe 50%, #e0e7ff 100%)'
  },
  vibrant: {
    bgClass: 'bg-gradient-to-r from-white/95 via-sky-50/95 to-indigo-50/95 text-zinc-900 border-sky-300 shadow-[0_12px_40px_rgba(56,189,248,0.35)]',
    previewBg: 'linear-gradient(135deg, #ffffff 0%, #bae6fd 50%, #c7d2fe 100%)'
  }
}, {
  id: 'ocean-blue',
  name: '深海极光湛蓝',
  desc: '午夜湛蓝直跃电光天青极光',
  isLight: false,
  subtle: {
    bgClass: 'bg-gradient-to-r from-[#071126]/95 via-[#0c2147]/95 to-[#101935]/95 text-white border-blue-400/30 shadow-blue-950/50',
    previewBg: 'linear-gradient(135deg, #071126, #1d4ed8)'
  },
  balanced: {
    bgClass: 'bg-gradient-to-r from-[#041538] via-[#0369a1] to-[#1e40af] text-white border-sky-400/45 shadow-[0_12px_40px_rgba(2,132,199,0.45)]',
    previewBg: 'linear-gradient(135deg, #041538 0%, #0284c7 50%, #1e40af 100%)'
  },
  vibrant: {
    bgClass: 'bg-gradient-to-r from-[#031b4e] via-[#0284c7] to-[#2563eb] text-white border-sky-300/70 shadow-[0_14px_45px_rgba(14,165,233,0.6)]',
    previewBg: 'linear-gradient(135deg, #031b4e 0%, #0284c7 50%, #38bdf8 100%)'
  }
}, {
  id: 'cyber-purple',
  name: '赛博霓虹幻紫',
  desc: '暗夜魅紫到高能电光粉紫渐变',
  isLight: false,
  subtle: {
    bgClass: 'bg-gradient-to-r from-[#140826]/95 via-[#241042]/95 to-[#120d2b]/95 text-white border-purple-400/35 shadow-purple-950/50',
    previewBg: 'linear-gradient(135deg, #140826, #7e22ce)'
  },
  balanced: {
    bgClass: 'bg-gradient-to-r from-[#190529] via-[#7e22ce] to-[#c026d3] text-white border-purple-400/45 shadow-[0_12px_40px_rgba(126,34,206,0.45)]',
    previewBg: 'linear-gradient(135deg, #190529 0%, #7e22ce 50%, #e879f9 100%)'
  },
  vibrant: {
    bgClass: 'bg-gradient-to-r from-[#24063c] via-[#9333ea] to-[#ec4899] text-white border-fuchsia-400/70 shadow-[0_14px_45px_rgba(168,85,247,0.6)]',
    previewBg: 'linear-gradient(135deg, #24063c 0%, #9333ea 50%, #f472b6 100%)'
  }
}, {
  id: 'emerald-jade',
  name: '翡翠极客碧绿',
  desc: '幽深暗绿到高饱和电光翠绿',
  isLight: false,
  subtle: {
    bgClass: 'bg-gradient-to-r from-[#051a14]/95 via-[#0a2e24]/95 to-[#07191e]/95 text-white border-emerald-400/30 shadow-emerald-950/50',
    previewBg: 'linear-gradient(135deg, #051a14, #059669)'
  },
  balanced: {
    bgClass: 'bg-gradient-to-r from-[#032317] via-[#047857] to-[#0f766e] text-white border-emerald-400/45 shadow-[0_12px_40px_rgba(5,150,105,0.45)]',
    previewBg: 'linear-gradient(135deg, #032317 0%, #059669 50%, #10b981 100%)'
  },
  vibrant: {
    bgClass: 'bg-gradient-to-r from-[#023120] via-[#059669] to-[#10b981] text-white border-emerald-400/70 shadow-[0_14px_45px_rgba(16,185,129,0.6)]',
    previewBg: 'linear-gradient(135deg, #023120 0%, #059669 50%, #34d399 100%)'
  }
}, {
  id: 'sunset-amber',
  name: '日落流金烈焰',
  desc: '暗夜暖金到炽热熔金夕阳',
  isLight: false,
  subtle: {
    bgClass: 'bg-gradient-to-r from-[#1f1108]/95 via-[#30190b]/95 to-[#1c0f13]/95 text-white border-amber-400/30 shadow-amber-950/50',
    previewBg: 'linear-gradient(135deg, #1f1108, #d97706)'
  },
  balanced: {
    bgClass: 'bg-gradient-to-r from-[#2c1004] via-[#c2410c] to-[#b45309] text-white border-amber-400/45 shadow-[0_12px_40px_rgba(194,65,12,0.45)]',
    previewBg: 'linear-gradient(135deg, #2c1004 0%, #ea580c 50%, #f59e0b 100%)'
  },
  vibrant: {
    bgClass: 'bg-gradient-to-r from-[#3e1603] via-[#ea580c] to-[#f59e0b] text-white border-amber-400/70 shadow-[0_14px_45px_rgba(245,158,11,0.6)]',
    previewBg: 'linear-gradient(135deg, #3e1603 0%, #ea580c 50%, #fbbf24 100%)'
  }
}, {
  id: 'rose-velvet',
  name: '丝绒烈焰暗玫',
  desc: '深夜暗玫到娇艳烈火绯红',
  isLight: false,
  subtle: {
    bgClass: 'bg-gradient-to-r from-[#240914]/95 via-[#380e20]/95 to-[#1f0b1d]/95 text-white border-rose-400/30 shadow-rose-950/50',
    previewBg: 'linear-gradient(135deg, #240914, #e11d48)'
  },
  balanced: {
    bgClass: 'bg-gradient-to-r from-[#2b0512] via-[#be123c] to-[#9f1239] text-white border-rose-400/45 shadow-[0_12px_40px_rgba(190,18,60,0.45)]',
    previewBg: 'linear-gradient(135deg, #2b0512 0%, #e11d48 50%, #f43f5e 100%)'
  },
  vibrant: {
    bgClass: 'bg-gradient-to-r from-[#380616] via-[#e11d48] to-[#fb7185] text-white border-rose-400/70 shadow-[0_14px_45px_rgba(244,63,94,0.6)]',
    previewBg: 'linear-gradient(135deg, #380616 0%, #e11d48 50%, #fda4af 100%)'
  }
}, {
  id: 'vision-spectrum',
  name: '星系光谱幻彩',
  desc: 'Apple 空间光谱多维全色域流体',
  isLight: false,
  subtle: {
    bgClass: 'bg-gradient-to-r from-[#0d1322] via-[#1a233a] to-[#121829] text-white border-purple-400/30 shadow-black/50',
    previewBg: 'linear-gradient(135deg, #0d1322 0%, #1e293b 50%, #121829 100%)'
  },
  balanced: {
    bgClass: 'bg-gradient-to-r from-[#0b1329] via-[#1d4ed8] via-[#6d28d9] to-[#be185d] text-white border-purple-400/50 shadow-[0_12px_40px_rgba(109,40,217,0.5)]',
    previewBg: 'linear-gradient(135deg, #1d4ed8 0%, #7c3aed 50%, #db2777 100%)'
  },
  vibrant: {
    bgClass: 'bg-gradient-to-r from-[#0f172a] via-[#2563eb] via-[#9333ea] to-[#ec4899] text-white border-purple-300/70 shadow-[0_14px_45px_rgba(147,51,234,0.65)]',
    previewBg: 'linear-gradient(135deg, #2563eb 0%, #9333ea 50%, #ec4899 100%)'
  }
}, {
  id: 'custom',
  name: '自定义拾色',
  desc: '任意调配专属灵动岛色',
  isLight: false,
  subtle: {
    bgClass: 'text-white shadow-black/40',
    previewBg: 'conic-gradient(from 90deg, #3b82f6, #8b5cf6, #ec4899, #10b981, #3b82f6)'
  },
  balanced: {
    bgClass: 'text-white shadow-black/40',
    previewBg: 'conic-gradient(from 90deg, #3b82f6, #8b5cf6, #ec4899, #10b981, #3b82f6)'
  },
  vibrant: {
    bgClass: 'text-white shadow-black/40',
    previewBg: 'conic-gradient(from 90deg, #3b82f6, #8b5cf6, #ec4899, #10b981, #3b82f6)'
  }
}];
const THEME_PRESETS = [
// === 🔥 多巴胺主题色系（参考灵动岛高能色彩与流光渐变，首发鲜橙色！） ===
{
  id: 'dopamine-orange',
  name: '鲜橙色 · 日落流金',
  desc: '高饱和元气多巴胺鲜橙与日落流光',
  category: 'dopamine',
  dark: false,
  appBg: 'bg-[#FFF3E6] text-orange-950',
  sidebarBg: 'bg-orange-50/80 border-orange-200/80 shadow-orange-900/10',
  mainBg: 'bg-orange-50/75 border-orange-200/80 shadow-orange-900/10',
  blob1: 'bg-orange-400/35',
  blob2: 'bg-amber-400/30',
  blob3: 'bg-red-300/25',
  basicBg: '#FFE8D1',
  gradientBg: 'linear-gradient(135deg, #2c1004 0%, #ea580c 52%, #fbbf24 100%)',
  previewColors: ['#FF6B00', '#FFF7ED', '#EA580C']
}, {
  id: 'dopamine-dark-purple',
  name: '暗紫 · 赛博暗夜魅紫',
  desc: '参考灵动岛暗紫，深邃神秘暗夜紫',
  category: 'dopamine',
  dark: true,
  appBg: 'bg-[#120722] text-purple-100',
  sidebarBg: 'bg-[#190a2e]/80 border-purple-500/25 shadow-black/60',
  mainBg: 'bg-[#150826]/75 border-purple-500/25 shadow-black/60',
  blob1: 'bg-purple-600/30',
  blob2: 'bg-fuchsia-600/20',
  blob3: 'bg-indigo-600/25',
  basicBg: '#160829',
  gradientBg: 'linear-gradient(135deg, #0a0314 0%, #4c1d95 52%, #7e22ce 100%)',
  previewColors: ['#2E1065', '#1E1035', '#9333EA']
}, {
  id: 'dopamine-bright-purple',
  name: '亮紫 · 电光霓虹幻紫',
  desc: '高能多巴胺亮紫与电光粉紫渐变',
  category: 'dopamine',
  dark: false,
  appBg: 'bg-[#F5EBFD] text-purple-950',
  sidebarBg: 'bg-purple-50/80 border-purple-200/80 shadow-purple-900/10',
  mainBg: 'bg-purple-50/75 border-purple-200/80 shadow-purple-900/10',
  blob1: 'bg-fuchsia-400/35',
  blob2: 'bg-purple-400/35',
  blob3: 'bg-pink-300/30',
  basicBg: '#EEDBFF',
  gradientBg: 'linear-gradient(135deg, #3b0764 0%, #9333ea 50%, #f472b6 100%)',
  previewColors: ['#A855F7', '#FAF5FF', '#9333EA']
}, {
  id: 'dopamine-cyan-blue',
  name: '青蓝 · 电光冰川天青',
  desc: '澄澈通透多巴胺青蓝与极光水色',
  category: 'dopamine',
  dark: false,
  appBg: 'bg-[#E6FAFD] text-cyan-950',
  sidebarBg: 'bg-cyan-50/80 border-cyan-200/80 shadow-cyan-900/10',
  mainBg: 'bg-cyan-50/75 border-cyan-200/80 shadow-cyan-900/10',
  blob1: 'bg-cyan-400/35',
  blob2: 'bg-sky-400/30',
  blob3: 'bg-teal-300/25',
  basicBg: '#D5F6FB',
  gradientBg: 'linear-gradient(135deg, #042f2e 0%, #0891b2 50%, #38bdf8 100%)',
  previewColors: ['#06B6D4', '#ECFEFF', '#0284C7']
}, {
  id: 'dopamine-emerald',
  name: '碧绿 · 翡翠极客碧绿',
  desc: '参考灵动岛翡翠碧绿，高饱和电光翠绿',
  category: 'dopamine',
  dark: false,
  appBg: 'bg-[#E6FAF2] text-emerald-950',
  sidebarBg: 'bg-emerald-50/80 border-emerald-200/80 shadow-emerald-900/10',
  mainBg: 'bg-emerald-50/75 border-emerald-200/80 shadow-emerald-900/10',
  blob1: 'bg-emerald-400/35',
  blob2: 'bg-teal-400/30',
  blob3: 'bg-green-300/25',
  basicBg: '#D1FAE5',
  gradientBg: 'linear-gradient(135deg, #022c22 0%, #059669 52%, #34d399 100%)',
  previewColors: ['#10B981', '#ECFDF5', '#059669']
}, {
  id: 'dopamine-fire-red',
  name: '火红 · 炽热多巴胺烈焰',
  desc: '肆意张扬的烈焰火红与绯红流光',
  category: 'dopamine',
  dark: false,
  appBg: 'bg-[#FEECEC] text-red-950',
  sidebarBg: 'bg-red-50/80 border-red-200/80 shadow-red-900/10',
  mainBg: 'bg-red-50/75 border-red-200/80 shadow-red-900/10',
  blob1: 'bg-red-400/35',
  blob2: 'bg-rose-400/30',
  blob3: 'bg-orange-300/25',
  basicBg: '#FCDADA',
  gradientBg: 'linear-gradient(135deg, #450a0a 0%, #dc2626 50%, #fb7185 100%)',
  previewColors: ['#EF4444', '#FEF2F2', '#DC2626']
}, {
  id: 'dopamine-dark-red',
  name: '暗红 · 丝绒烈焰暗玫',
  desc: '参考灵动岛暗玫，深夜丝绒酒红渐变',
  category: 'dopamine',
  dark: true,
  appBg: 'bg-[#1D060E] text-rose-100',
  sidebarBg: 'bg-[#260813]/80 border-rose-500/25 shadow-black/60',
  mainBg: 'bg-[#210710]/75 border-rose-500/25 shadow-black/60',
  blob1: 'bg-rose-600/30',
  blob2: 'bg-red-700/25',
  blob3: 'bg-pink-600/20',
  basicBg: '#240711',
  gradientBg: 'linear-gradient(135deg, #140308 0%, #881337 52%, #e11d48 100%)',
  previewColors: ['#881337', '#2B0612', '#E11D48']
}, {
  id: 'dopamine-azure-blue',
  name: '湛蓝 · 深海极光湛蓝',
  desc: '参考灵动岛深海湛蓝，午夜电光蓝渐变',
  category: 'dopamine',
  dark: true,
  appBg: 'bg-[#06132E] text-sky-100',
  sidebarBg: 'bg-[#091b40]/80 border-sky-500/25 shadow-black/60',
  mainBg: 'bg-[#071636]/75 border-sky-500/25 shadow-black/60',
  blob1: 'bg-blue-600/30',
  blob2: 'bg-sky-500/25',
  blob3: 'bg-indigo-600/25',
  basicBg: '#08183A',
  gradientBg: 'linear-gradient(135deg, #030b1c 0%, #0369a1 50%, #2563eb 100%)',
  previewColors: ['#0284C7', '#082F49', '#2563EB']
},
// === 🍎 精简经典代表色（去除重复相似款，每类仅保留最具代表性一款） ===
{
  id: 'apple-light',
  name: '冰川纯白 · 原生浅色',
  desc: '通透纯净浅色液态玻璃基底',
  category: 'classic',
  dark: false,
  appBg: 'bg-[#F2F4F8] text-zinc-900',
  sidebarBg: 'bg-white/75 border-white/80 shadow-zinc-200/60',
  mainBg: 'bg-white/80 border-white/90 shadow-zinc-200/70',
  blob1: 'bg-blue-400/20',
  blob2: 'bg-indigo-300/20',
  blob3: 'bg-teal-300/20',
  basicBg: '#F2F4F8',
  gradientBg: 'linear-gradient(135deg, #ffffff 0%, #e0f2fe 52%, #e0e7ff 100%)',
  previewColors: ['#F2F4F8', '#FFFFFF', '#007AFF']
}, {
  id: 'apple-dark',
  name: '曜石暗夜 · 原生深色',
  desc: '深邃高对比暗黑钛金基底',
  category: 'classic',
  dark: true,
  appBg: 'bg-[#090A0F] text-zinc-100',
  sidebarBg: 'bg-zinc-900/75 border-white/[0.08] shadow-black/40',
  mainBg: 'bg-zinc-900/65 border-white/[0.08] shadow-black/40',
  blob1: 'bg-blue-600/15',
  blob2: 'bg-purple-600/12',
  blob3: 'bg-emerald-600/12',
  basicBg: '#090A0F',
  gradientBg: 'linear-gradient(135deg, #05060a 0%, #161f33 52%, #0c101b 100%)',
  previewColors: ['#090A0F', '#18181B', '#3B82F6']
}, {
  id: 'titanium-silver',
  name: '钛金属灰 · 极简中性',
  desc: 'Apple 原色钛金属冷冽银灰',
  category: 'classic',
  dark: false,
  appBg: 'bg-[#E4E6EB] text-zinc-900',
  sidebarBg: 'bg-[#F1F3F6]/85 border-white/80 shadow-slate-300/50',
  mainBg: 'bg-[#ECEEF2]/90 border-white/90 shadow-slate-300/60',
  blob1: 'bg-slate-400/25',
  blob2: 'bg-zinc-400/20',
  blob3: 'bg-sky-300/15',
  basicBg: '#E4E6EB',
  gradientBg: 'linear-gradient(135deg, #cbd5e1 0%, #f1f5f9 50%, #94a3b8 100%)',
  previewColors: ['#E4E6EB', '#F8FAFC', '#475569']
}, {
  id: 'morandi-sage',
  name: '莫兰迪青 · 静谧森系',
  desc: '温润低饱和鼠尾草灰绿护眼基底',
  category: 'classic',
  dark: false,
  appBg: 'bg-[#E6ECE8] text-stone-900',
  sidebarBg: 'bg-[#F2F6F3]/85 border-emerald-200/60 shadow-stone-300/50',
  mainBg: 'bg-[#ECF2EE]/90 border-white/85 shadow-stone-300/50',
  blob1: 'bg-emerald-300/20',
  blob2: 'bg-teal-200/20',
  blob3: 'bg-stone-300/20',
  basicBg: '#E6ECE8',
  gradientBg: 'linear-gradient(135deg, #d1fae5 0%, #e6ece8 50%, #99f6e4 100%)',
  previewColors: ['#E6ECE8', '#F2F6F3', '#0D9488']
}];
const BUBBLE_STYLES = [{
  id: 'imessage',
  name: 'iMessage 经典尾角',
  desc: '圆润饱满 + 发送方微尖尾角',
  meRadius: 'rounded-3xl rounded-tr-md',
  botRadius: 'rounded-3xl rounded-tl-md',
  extraClass: 'px-4 py-3'
}, {
  id: 'wechat',
  name: '微信经典圆角',
  desc: '利落紧凑的国民聊天框造型',
  meRadius: 'rounded-2xl rounded-tr-xs',
  botRadius: 'rounded-2xl rounded-tl-xs',
  extraClass: 'px-3.5 py-2.5'
}, {
  id: 'glass',
  name: 'VisionOS 悬浮玻璃',
  desc: '高光描边 + 空间立体通透阴影',
  meRadius: 'rounded-3xl',
  botRadius: 'rounded-3xl',
  extraClass: 'px-4 py-3 backdrop-blur-xl ring-1 ring-white/25 shadow-lg'
}, {
  id: 'minimal',
  name: '极客硬朗线框',
  desc: '小圆角 + 侧边撞色强调饰条',
  meRadius: 'rounded-xl border-r-4 border-r-white/60',
  botRadius: 'rounded-xl border-l-4 border-l-blue-500',
  extraClass: 'px-4 py-2.5'
}, {
  id: 'candy',
  name: '流体糖果胶囊',
  desc: '超大曲率全圆润抱枕质感',
  meRadius: 'rounded-[28px]',
  botRadius: 'rounded-[28px]',
  extraClass: 'px-5 py-3'
}, {
  id: 'soft-square',
  name: '柔和方卡',
  desc: '克制中圆角，适合长消息与阅读',
  meRadius: 'rounded-[1.15rem] rounded-tr-md',
  botRadius: 'rounded-[1.15rem] rounded-tl-md',
  extraClass: 'px-4 py-3 border border-black/5 dark:border-white/10 shadow-sm'
}, {
  id: 'terminal',
  name: '终端侧线',
  desc: '更直的边角与彩色侧线，强调信息感',
  meRadius: 'rounded-lg rounded-tr-none border-r-2 border-r-white/60',
  botRadius: 'rounded-lg rounded-tl-none border-l-2 border-l-emerald-500',
  extraClass: 'px-3.5 py-2.5 font-medium shadow-sm'
}];
const MY_BUBBLE_COLORS = [{
  id: 'apple-blue',
  name: 'iMessage 经典蓝',
  className: 'bg-gradient-to-br from-[#007AFF] to-[#0055D4] text-white shadow-md shadow-blue-500/15',
  swatch: 'linear-gradient(135deg, #007AFF, #0055D4)'
}, {
  id: 'wechat-green',
  name: '微信原生莹绿',
  className: 'bg-[#95EC69] text-zinc-900 shadow-xs border border-[#85dc59]',
  swatch: 'linear-gradient(135deg, #95EC69, #7ed952)'
}, {
  id: 'emerald-pro',
  name: '深翠极客绿',
  className: 'bg-gradient-to-br from-[#07C160] to-[#059669] text-white shadow-md shadow-emerald-500/15',
  swatch: 'linear-gradient(135deg, #07C160, #059669)'
}, {
  id: 'violet-nebula',
  name: '星云幻彩紫',
  className: 'bg-gradient-to-br from-violet-600 via-purple-600 to-indigo-600 text-white shadow-md shadow-purple-500/20',
  swatch: 'linear-gradient(135deg, #7C3AED, #4F46E5)'
}, {
  id: 'rose-sunset',
  name: '落日绯红渐变',
  className: 'bg-gradient-to-br from-rose-500 via-pink-500 to-orange-500 text-white shadow-md shadow-rose-500/20',
  swatch: 'linear-gradient(135deg, #F43F5E, #F97316)'
}, {
  id: 'caramel-amber',
  name: '焦糖暖阳金',
  className: 'bg-gradient-to-br from-amber-500 via-orange-500 to-amber-600 text-white shadow-md shadow-amber-500/20',
  swatch: 'linear-gradient(135deg, #F59E0B, #EA580C)'
}, {
  id: 'sunflower-warm',
  name: '奶油向日葵黄',
  className: 'bg-[#FDE68A] text-amber-950 border border-amber-300 shadow-xs',
  swatch: 'linear-gradient(135deg, #FDE68A, #FCD34D)'
}, {
  id: 'morandi-blue',
  name: '莫兰迪雾霾蓝',
  className: 'bg-gradient-to-br from-[#38BDF8] via-[#0284C7] to-[#0369A1] text-white shadow-md shadow-sky-500/15',
  swatch: 'linear-gradient(135deg, #38BDF8, #0369A1)'
}, {
  id: 'burgundy-wine',
  name: '波尔多红丝绒',
  className: 'bg-gradient-to-br from-[#9F1239] via-[#881337] to-[#4C0519] text-rose-50 shadow-md shadow-rose-900/25',
  swatch: 'linear-gradient(135deg, #9F1239, #4C0519)'
}, {
  id: 'obsidian-gold',
  name: '黑金尊享版',
  className: 'bg-gradient-to-br from-zinc-900 via-zinc-800 to-stone-900 text-amber-300 border border-amber-500/35 shadow-md',
  swatch: 'linear-gradient(135deg, #18181B, #B45309)'
}, {
  id: 'cyber-cyan',
  name: '赛博冰川青',
  className: 'bg-gradient-to-br from-cyan-500 to-blue-600 text-white shadow-md shadow-cyan-500/20',
  swatch: 'linear-gradient(135deg, #06B6D4, #2563EB)'
}, {
  id: 'custom',
  name: '自定义气泡色',
  className: 'shadow-md',
  swatch: 'conic-gradient(from 90deg, #007AFF, #95EC69, #F43F5E, #8B5CF6, #007AFF)'
}];
const BOT_BUBBLE_PRESETS = [{
  id: 'snow-white',
  name: '纯净云白',
  bg: '#FFFFFF',
  text: '#18181B'
}, {
  id: 'obsidian-slate',
  name: '暗夜曜石',
  bg: '#1E2028',
  text: '#F4F4F5'
}, {
  id: 'deepseek-ice',
  name: '极客冰蓝',
  bg: '#EFF6FF',
  text: '#1E3A8A'
}, {
  id: 'gpt-mint',
  name: '硅谷薄荷绿',
  bg: '#ECFDF5',
  text: '#064E3B'
}, {
  id: 'kimi-lavender',
  name: '星云微光紫',
  bg: '#F5F3FF',
  text: '#4C1D95'
}, {
  id: 'claude-warm',
  name: '羊皮暖杏色',
  bg: '#FFFBEB',
  text: '#78350F'
}, {
  id: 'rose-quartz',
  name: '晚霞樱花粉',
  bg: '#FFF1F2',
  text: '#881337'
}, {
  id: 'sunflower-cream',
  name: '奶油鹅黄',
  bg: '#FEF9C3',
  text: '#713F12'
}, {
  id: 'terracotta-sand',
  name: '赤陶暖砂',
  bg: '#FFEDD5',
  text: '#7C2D12'
}, {
  id: 'celadon-glaze',
  name: '汝窑天青',
  bg: '#CCFBF1',
  text: '#134E4A'
}, {
  id: 'espresso-dark',
  name: '深夜浓咖',
  bg: '#271A14',
  text: '#FDE68A'
}, {
  id: 'cyber-matrix',
  name: '黑客终端绿',
  bg: '#091914',
  text: '#6EE7B7'
}];
const AVATAR_GRADIENTS = [{
  id: 'from-blue-500 via-indigo-500 to-violet-600',
  name: '深海电光蓝',
  preview: 'linear-gradient(135deg, #3B82F6, #7C3AED)'
}, {
  id: 'from-emerald-400 via-teal-500 to-cyan-600',
  name: '薄荷青翠绿',
  preview: 'linear-gradient(135deg, #34D399, #0891B2)'
}, {
  id: 'from-fuchsia-500 via-purple-500 to-indigo-600',
  name: '星云霓虹紫',
  preview: 'linear-gradient(135deg, #D946EF, #4F46E5)'
}, {
  id: 'from-amber-500 via-orange-500 to-rose-600',
  name: '日落熔岩橙',
  preview: 'linear-gradient(135deg, #F59E0B, #E11D48)'
}, {
  id: 'from-rose-500 via-pink-500 to-purple-600',
  name: '樱花绯红粉',
  preview: 'linear-gradient(135deg, #F43F5E, #9333EA)'
}, {
  id: 'from-zinc-700 via-zinc-800 to-black',
  name: '曜石极客黑',
  preview: 'linear-gradient(135deg, #3F3F46, #09090B)'
}, {
  id: 'from-cyan-400 via-sky-500 to-blue-600',
  name: '冰川天际蓝',
  preview: 'linear-gradient(135deg, #22D3EE, #2563EB)'
}, {
  id: 'from-lime-400 via-emerald-500 to-green-600',
  name: '微信活力绿',
  preview: 'linear-gradient(135deg, #A3E635, #16A34A)'
}];
const EMOJI_PRESETS = ['🧑‍💻', '🦊', '🐱', '🚀', '🤖', '🧠', '⚡', '🐉', '👾', '🎨', '🕶️', '👑', '🦄', '🔥', '🐼', '🦁', '🎯', '💎', '🌊', '✨'];
const SILENT_REPLY_TOKEN = '[[WEB_H_SILENT]]';
const PERSONA_REMINDER_INTERVAL_MS = 20 * 60 * 1000;

// 动态轮换自然语言包装模板（消除固定内容指纹）
const NATURAL_HISTORY_INTROS = [groupName => `以下是「${groupName}」群里大家刚聊的内容：`, groupName => `「${groupName}」刚刚有几条新消息，你看看：`, groupName => `群里（「${groupName}」）大家最新聊到了这些：`, groupName => `同步一下「${groupName}」里的最新对话：`, groupName => `大家在「${groupName}」里刚说了这几句：`];
const NATURAL_REPLY_CLOSERS = ['请顺着上面的话自然接一两句（口语化一点，别列123点，控制在50字内）：', '像平时在微信群闲聊一样直接回一两句就行，不用分点也不用客套：', '请直接接话聊两句你的看法，简短犀利一点，别用首先其次或列表：', '直接输出你接话的内容本身（1~2句大白话即可，严禁长篇说教）：', '按群友聊天的口气回一两句，越接地气越好，不要带任何格式前缀：'];
const NATURAL_PERSONA_WRAPPERS = [(name, role, persona) => `\n\n（顺便记住你的群内身份是「${name} · ${role}」：${persona}）`, (name, role, persona) => `\n\n（提示：你在群里是「${name}」，定位是${role}。性格设定：${persona}）`, (name, role, persona) => `\n\n（请保持你「${name}（${role}）」的人设口吻发言：${persona}）`, (name, role, persona) => `\n\n（你的角色背景：${name}，${role}——${persona}）`];

// 敏感报错与限流特征词检测正则（命中立即主动熔断，绝不自动重试刷接口）
const RISK_CONTROL_REGEX = /too many requests|unusual activity|verify you are human|cloudflare|rate limit|just a moment|security check|access denied|请求过于频繁|操作太频繁|验证码|人机验证|安全验证|访问受限|账号异常|达到上限|次数已达上限|try again later|429/i;
function isRiskControlTriggered(text = '') {
  return RISK_CONTROL_REGEX.test(String(text || ''));
}
const DEFAULT_FEATURE_SETTINGS = Object.freeze({
  mentionFirst: true,
  expertiseFirst: true,
  noConsecutiveStarter: true,
  raceFirstToken: false,
  quoteReplies: true,
  quotePermission: 'both',
  // 'both' (都可引用) | 'me-only' (仅我可引用) | 'ai-only' (仅AI可引用) | 'partial' (部分引用) | 'off' (全部关闭)
  quoteMode: 'smart',
  // 'smart' (智能接话引用) | 'always' (每条必引) | 'mention-or-pin' (仅点名或置顶时引用)
  partialAllowMe: true,
  // 部分引用模式下：我是否可手动引用
  partialAllowedBotIds: ['deepseek', 'chatgpt', 'kimi', 'claude'],
  // 部分引用模式下：允许自动挂引用的 AI 列表
  quoteTargetFilter: 'all',
  // 'all' (所有消息) | 'ai-only' (仅引用AI发言) | 'me-only' (仅引用主理人) | 'pinned-only' (仅引用置顶消息)
  quoteMaxLength: 80,
  // 引用预览截断字数：40 | 80 | 140
  forwardWithProvenance: true,
  // 转发消息时向目标群 AI 强透传「转发自哪个群聊 + 哪个 AI/成员」
  autoDispatchOnForward: false,
  // 转发消息到目标群后是否立即唤醒目标群 AI 接话讨论
  replyLengthMode: 'short-50',
  // 'short-50' (50字极简) | 'medium-120' (120字适中) | 'deep-300' (300字深度) | 'unlimited' (不限字数)
  relayDelayMode: 'natural',
  // 'instant' (0.4秒极速) | 'natural' (1.2秒拟人停顿) | 'safe' (2.8秒防风控慢速)
  preserveCodeBlocks: true,
  // 代码块/报错堆栈免受长消息截断限制
  antiEchoGuard: true,
  // AI 复读机与同质化观点抑制
  unreadBadgeShape: 'pill',
  // 'pill' | 'capsule' | 'dot'
  unreadBadgeSize: 'md',
  // 'sm' | 'md' | 'lg'
  unreadBadgeColor: '#FF3B30',
  // 未读角标颜色
  conclusionCard: true,
  saveLocal: true,
  crossPlatformPong: true,
  guidePhases: true,
  stopOnConsensus: true,
  queueWhileBusy: true,
  firstSentenceHandoff: false,
  skipStalledTab: true,
  mergeIncrementalContext: true,
  rotatePromptFingerprints: true,
  circuitBreakOnRisk: true,
  maxContextChars: 800,
  maxSessionRounds: 45 // 0 表示无限大 (∞)
});

const INITIAL_PERSONA_MODES = [{
  id: 'casual-wechat',
  name: '真人群聊',
  instruction: '请完全按真人在微信群闲聊互怼的口气说话，每次绝不超过2句话，严禁分点列举和说教。'
}];
const EMERGENCY_DOT_COLORS = [{
  name: '珊瑚红',
  value: '#FF5F56'
}, {
  name: '琥珀橙',
  value: '#FF9F0A'
}, {
  name: '苹果蓝',
  value: '#007AFF'
}, {
  name: '翡翠绿',
  value: '#30D158'
}, {
  name: '紫罗兰',
  value: '#BF5AF2'
}];
function createDefaultGroupState(saved = {}, bots = [], groupId = '') {
  const legacyCursors = Object.fromEntries(bots.map(bot => [bot.id, bot.syncCursorByGroup?.[groupId] ?? (groupId === 'group-1' ? bot.syncCursor || 0 : 0)]));
  const autoPilot = saved.autoPilot && typeof saved.autoPilot === 'object' ? saved.autoPilot : {};
  return {
    ...saved,
    pinnedMessageIds: Array.isArray(saved.pinnedMessageIds) ? saved.pinnedMessageIds : [],
    activePersonaId: typeof saved.activePersonaId === 'string' ? saved.activePersonaId : null,
    lastStarterId: saved.lastStarterId || null,
    syncCursors: {
      ...legacyCursors,
      ...(saved.syncCursors || {})
    },
    unreadCount: Number(saved.unreadCount) || 0,
    lastViewedMessageId: Number(saved.lastViewedMessageId) || 0,
    sessionRounds: Math.max(0, Number(saved.sessionRounds) || 0),
    circuitBrokenBots: saved.circuitBrokenBots && typeof saved.circuitBrokenBots === 'object' ? saved.circuitBrokenBots : {},
    autoPilot: {
      enabled: autoPilot.enabled === true,
      remainingRounds: Math.max(0, Number(autoPilot.remainingRounds) || 0),
      totalRounds: Math.max(0, Number(autoPilot.totalRounds) || 0),
      lastSpeakerId: autoPilot.lastSpeakerId || null,
      phase: autoPilot.phase || 'break-ice',
      conclusionPending: autoPilot.conclusionPending === true,
      ...autoPilot
    }
  };
}
function restoreGroupStates(savedStates, groups, bots) {
  const source = savedStates && typeof savedStates === 'object' ? savedStates : {};
  const ids = new Set([...Object.keys(source), ...(groups || []).map(group => group.id)]);
  return Object.fromEntries([...ids].map(groupId => {
    const state = createDefaultGroupState(source[groupId] || {}, bots, groupId);
    if (state.autoPilot.enabled) state.autoPilot.activeBotIds = [];
    return [groupId, state];
  }));
}
function expertiseScore(bot, text) {
  const source = `${bot.roleTag || ''} ${bot.persona || ''}`.toLowerCase();
  const topic = String(text || '').toLowerCase();
  const clusters = [{
    words: ['代码', '架构', 'bug', '接口', '数据库', '并发', 'typescript', 'react', '程序', '技术', 'code', 'api'],
    roles: ['架构', '开发', '工程', '技术', '程序', 'coder', 'engineer']
  }, {
    words: ['界面', '视觉', '颜色', '布局', '交互', '字体', '设计', '美学', 'ui', 'ux', 'css'],
    roles: ['设计', '视觉', '交互', 'ui', 'ux', '美学']
  }, {
    words: ['产品', '用户', '市场', '增长', '需求', '商业', '运营', '竞品', 'product', 'growth'],
    roles: ['产品', '增长', '市场', '运营', '商业']
  }];
  return clusters.reduce((score, cluster) => {
    const topicMatches = cluster.words.filter(word => topic.includes(word)).length;
    const roleMatches = cluster.roles.filter(word => source.includes(word)).length;
    return score + (topicMatches > 0 ? topicMatches * roleMatches : 0);
  }, 0);
}
function parseConclusionSections(text, messages = []) {
  const source = String(text || '').trim();
  const pick = patterns => {
    for (const pattern of patterns) {
      const match = source.match(pattern);
      if (match?.[1]) return match[1].trim().replace(/^[-：:\s]+/, '');
    }
    return '';
  };
  const aiMessages = messages.filter(message => message.senderId !== 'me' && message.type !== 'conclusion-card' && message.text);
  return {
    core: pick([/核心共识\s*[：:]\s*([\s\S]*?)(?=关键分歧点\s*[：:]|最终落地建议\s*[：:]|$)/i]),
    disagreements: pick([/关键分歧点\s*[：:]\s*([\s\S]*?)(?=最终落地建议\s*[：:]|$)/i]),
    recommendation: pick([/最终落地建议\s*[：:]\s*([\s\S]*?)$/i]),
    fallbackTopic: messages.filter(message => message.senderId === 'me' && message.text).slice(-1)[0]?.text || '本轮讨论',
    fallbackVoices: aiMessages.slice(-2).map(message => `${message.senderName}：${message.text}`).join('\n')
  };
}
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function getContrastRatio(background, foreground) {
  const luminance = value => {
    const normalized = String(value || '').replace('#', '');
    if (!/^[0-9a-f]{6}$/i.test(normalized)) return null;
    const channels = [0, 2, 4].map(index => parseInt(normalized.slice(index, index + 2), 16) / 255).map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const bg = luminance(background);
  const fg = luminance(foreground);
  if (bg === null || fg === null) return null;
  return (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05);
}
function findMentionedBots(text, bots) {
  const source = String(text || '');
  return bots.filter(bot => {
    const aliases = [...new Set([bot.id, bot.name, bot.name?.split(/\s+/)[0]].filter(Boolean))];
    return aliases.some(alias => {
      const cleanAlias = String(alias).trim();
      const taggedPattern = new RegExp(`(?:^|[^A-Za-z0-9_@])@${escapeRegex(cleanAlias)}(?=$|[\\s,，。.!！?？;；:：])`, 'i');
      const plainPattern = /^[A-Za-z0-9_]+$/.test(cleanAlias) ? new RegExp(`(?:^|[^A-Za-z0-9_])${escapeRegex(cleanAlias)}(?=$|[^A-Za-z0-9_])`, 'i') : null;
      return taggedPattern.test(source) || (plainPattern ? plainPattern.test(source) : source.includes(cleanAlias));
    });
  });
}
const WEB_H_STATE_KEY = 'web_h_state_v1';
const WEB_H_DB_NAME = 'web_h_userdata';
const WEB_H_DB_STORE = 'app_state';
function migrateSavedAppState(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.bots)) return snapshot;
  const legacyTargets = {
    deepseek: ['https://chat.deepseek.com/a/chat/s/98f2a1c4-7b11-4d9a', 'https://chat.deepseek.com/'],
    chatgpt: ['https://chatgpt.com/c/6724a8f0-12a4-800c-99b1', 'https://chatgpt.com/']
  };
  let changed = false;
  const bots = snapshot.bots.map(bot => {
    const pair = legacyTargets[bot?.id];
    if (!pair || bot.targetUrl !== pair[0]) return bot;
    changed = true;
    return { ...bot, targetUrl: pair[1] };
  });
  return changed ? { ...snapshot, bots } : snapshot;
}
function readLocalAppState() {
  try {
    return migrateSavedAppState(JSON.parse(window.localStorage.getItem(WEB_H_STATE_KEY) || 'null'));
  } catch {
    return null;
  }
}
function openAppStateDb() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error('IndexedDB is unavailable'));
    const request = window.indexedDB.open(WEB_H_DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(WEB_H_DB_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Cannot open IndexedDB'));
  });
}
async function readIndexedAppState() {
  const db = await openAppStateDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(WEB_H_DB_STORE, 'readonly').objectStore(WEB_H_DB_STORE).get('current');
    request.onsuccess = () => {
      db.close();
      resolve(migrateSavedAppState(request.result || null));
    };
    request.onerror = () => {
      db.close();
      reject(request.error || new Error('Cannot read IndexedDB'));
    };
  });
}
async function writeIndexedAppState(snapshot) {
  const db = await openAppStateDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(WEB_H_DB_STORE, 'readwrite');
    transaction.objectStore(WEB_H_DB_STORE).put(snapshot, 'current');
    transaction.oncomplete = () => {
      db.close();
      resolve(true);
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error || new Error('Cannot save IndexedDB'));
    };
    transaction.onabort = () => {
      db.close();
      reject(transaction.error || new Error('IndexedDB save aborted'));
    };
  });
}
function App() {
  const [initialSavedState] = useState(readLocalAppState);
  const [persistenceReady, setPersistenceReady] = useState(false);
  const [bots, setBots] = useState(() => Array.isArray(initialSavedState?.bots) ? initialSavedState.bots : INITIAL_BOTS);
  const [groups, setGroups] = useState(() => Array.isArray(initialSavedState?.groups) ? initialSavedState.groups : GROUPS);
  const [activeGroupId, setActiveGroupId] = useState(() => initialSavedState?.activeGroupId || 'group-1');
  const [groupMessages, setGroupMessages] = useState(() => initialSavedState?.groupMessages || {
    'group-1': INITIAL_MESSAGES,
    'group-2': [],
    'group-3': []
  });
  const [groupStates, setGroupStates] = useState(() => restoreGroupStates(initialSavedState?.groupStates, initialSavedState?.groups || GROUPS, initialSavedState?.bots || INITIAL_BOTS));
  const messages = groupMessages[activeGroupId] || [];
  const [inputText, setInputText] = useState('');
  const [pendingAttachments, setPendingAttachments] = useState([]);
  const attachmentFilesRef = useRef(new Map());
  const [groupEditorOpen, setGroupEditorOpen] = useState(false);
  const [groupDraft, setGroupDraft] = useState({
    id: null,
    name: '',
    memberIds: []
  });
  const [botEditorOpen, setBotEditorOpen] = useState(false);
  const [personaEditorBotId, setPersonaEditorBotId] = useState(null);
  const [botDraft, setBotDraft] = useState({
    templateId: '',
    name: '',
    roleTag: '',
    platform: '自定义网页 AI',
    targetUrl: '',
    selectorInput: 'div[contenteditable="true"]',
    selectorSend: 'button[type="submit"]',
    persona: '',
    badge: 'AI'
  });
  const [activeTab, setActiveTab] = useState('groups'); // 'chat' | 'sync' | 'anti-preach' | 'bridge'
  const [darkMode, setDarkMode] = useState(() => initialSavedState?.darkMode ?? false);
  const [wsConnected, setWsConnected] = useState(false);
  const [wsUrl, setWsUrl] = useState(() => initialSavedState?.wsUrl || 'ws://127.0.0.1:8765');
  const [dispatchMode, setDispatchMode] = useState(() => initialSavedState?.dispatchMode || 'smart-chain'); // 'smart-chain' | 'co-answer' | 'mention-only'
  const [chatSubMode, setChatSubMode] = useState(() => initialSavedState?.chatSubMode || 'smart'); // 'smart' | 'speed' | 'random'
  const [chatBotLimit, setChatBotLimit] = useState(() => initialSavedState?.chatBotLimit || 0); // 0 表示全选，1~N 限制人数
  const [islandGroupMenuOpen, setIslandGroupMenuOpen] = useState(false); // 灵动岛群聊子选项展开
  const [msgSelectMode, setMsgSelectMode] = useState(null); // null | 'pin' | 'forward' | 'delete'
  const [selectedMsgIds, setSelectedMsgIds] = useState([]);
  const [forwardModalOpen, setForwardModalOpen] = useState(false);
  const [forwardTargetGroupIds, setForwardTargetGroupIds] = useState([]);
  const [forwardAllGroups, setForwardAllGroups] = useState(false);
  const [forwardComment, setForwardComment] = useState('');
  const [themeCategoryFilter, setThemeCategoryFilter] = useState('all'); // 'all' | 'warm' | 'cool' | 'morandi' | 'dark' | 'classic'
  const [settingsCategoryTab, setSettingsCategoryTab] = useState('all'); // 'all' | 'dispatch' | 'quote-forward' | 'context' | 'safety'
  const [pinCardCollapsed, setPinCardCollapsed] = useState(false);
  const [pinDisplayMode, setPinDisplayMode] = useState(() => initialSavedState?.pinDisplayMode || 'both'); // 'both' | 'sidebar-only' | 'compact'
  const [expandedPinIds, setExpandedPinIds] = useState([]);
  const [islandExpanded, setIslandExpanded] = useState(false); // User clicked Dynamic Island to reveal controls
  const [islandPanel, setIslandPanel] = useState(null); // null | 'duty' | 'persona'
  const [islandEvent, setIslandEvent] = useState(null); // Important live notification inside Dynamic Island
  const [featureSettings, setFeatureSettings] = useState(() => ({
    ...DEFAULT_FEATURE_SETTINGS,
    ...(initialSavedState?.featureSettings || {})
  }));
  const [personaModes, setPersonaModes] = useState(() => Array.isArray(initialSavedState?.personaModes) ? initialSavedState.personaModes : INITIAL_PERSONA_MODES);
  const [systemSettingsOpen, setSystemSettingsOpen] = useState(false);
  const [emergencyDotColor, setEmergencyDotColor] = useState(() => initialSavedState?.emergencyDotColor || '#FF5F56');
  const [autoPilotRoundsDraft, setAutoPilotRoundsDraft] = useState(4);
  const [personaDraft, setPersonaDraft] = useState({
    name: '',
    instruction: ''
  });
  const [personaEditDraft, setPersonaEditDraft] = useState(null);
  const [pendingQuote, setPendingQuote] = useState(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState(null);
  const [antiPreachSuffix, setAntiPreachSuffix] = useState(() => initialSavedState?.antiPreachSuffix || '（群聊指令：你正在群里跟大家闲聊互怼。必须只用1~2句口语大白话接话，控制在50字内！严禁使用“首先/其次/总之”或1.2.3.分点列表，严禁客套和说教，直接输出回复内容本身）');
  const [typingBots, setTypingBots] = useState([]);
  const [selectedMsgForInspect, setSelectedMsgForInspect] = useState(null);
  const [editingBot, setEditingBot] = useState(null);
  const [copiedKey, setCopiedKey] = useState(null);
  const [toast, setToast] = useState(null);
  const [sidebarSearchQuery, setSidebarSearchQuery] = useState('');
  const [showRightDrawer, setShowRightDrawer] = useState(false);
  const [showLeftSidebar, setShowLeftSidebar] = useState(false);
  // === Android 手机版与内嵌多标签 AI 浏览器专属状态 ===
  const [mobileViewportMode, setMobileViewportMode] = useState('full-responsive'); // 'phone-frame' | 'full-responsive' | 'desktop'
  const [bridgeTransportMode, setBridgeTransportMode] = useState('in-app-webview'); // 'in-app-webview' (手机端最佳：应用内嵌多标签WebView内存直连) | 'lan-ws' (局域网/PC WebSocket)
  const [splitWebViewOpen, setSplitWebViewOpen] = useState(false); // 聊天页顶部是否展开「内嵌 AI 网页实时同屏窗口」
  const [splitWebViewHeight, setSplitWebViewHeight] = useState('compact'); // 'compact' | 'half'
  const [activeWebViewBotId, setActiveWebViewBotId] = useState('deepseek');
  const [webViewRenderMode, setWebViewRenderMode] = useState('native-iframe'); // 'interactive-dom' (内置实时DOM桥接页) | 'native-iframe' (原生WebView/Iframe挂载)
  const [webViewUaMode, setWebViewUaMode] = useState('mobile'); // 'mobile' | 'desktop'
  const [confirmModalState, setConfirmModalState] = useState(null); // 替代 window.confirm 的应用内确认弹窗
  const [inAppBrowserTabs, setInAppBrowserTabs] = useState(() => ({
    deepseek: {
      url: 'https://chat.deepseek.com/a/chat/s/afcabbe6-95cb-419a-8306-96f9520e5bee',
      loggedIn: true,
      isGenerating: false,
      draftInput: '',
      lastInjectedAt: '刚刚',
      turns: [{
        id: 1,
        role: 'user',
        text: '[群聊「真实测试」未同步的新消息]\n[我 (主理人)]: 你们好\n[GPT]: 行，刚才产品经理职业病犯了😂 以后我每次只说一个能落地的点，超字数罚我闭麦。',
        time: '00:07'
      }, {
        id: 2,
        role: 'assistant',
        text: '他话多的毛病靠自罚闭麦治，我赌三句内复发。去重方案先拿他那些废话试跑。',
        time: '00:07'
      }]
    },
    chatgpt: {
      url: 'https://chatgpt.com/c/6ae7640d-0958-83e8-b3e4-9181760a6025',
      loggedIn: true,
      isGenerating: false,
      draftInput: '',
      lastInjectedAt: '刚刚',
      turns: [{
        id: 1,
        role: 'user',
        text: '以下是「真实测试」群里大家刚聊的内容：\n[我 (主理人)]: gpt怎么说那麽多',
        time: '00:07'
      }, {
        id: 2,
        role: 'assistant',
        text: '行，刚才产品经理职业病犯了😂 以后我每次只说一个能落地的点，超字数罚我闭麦。',
        time: '00:07'
      }]
    },
    kimi: {
      url: 'https://kimi.moonshot.cn/chat/csu98712kjas812',
      loggedIn: true,
      isGenerating: false,
      draftInput: '',
      lastInjectedAt: '就绪',
      turns: [{
        id: 1,
        role: 'user',
        text: '【群聊入群设定协议】你的群昵称是 Kimi K2（吃瓜冲浪情报员）',
        time: '00:05'
      }, {
        id: 2,
        role: 'assistant',
        text: '收到！前排瓜子已备好，随时在手机内嵌网页里接话吃瓜~',
        time: '00:05'
      }]
    },
    claude: {
      url: 'https://claude.ai/chat/8b91c3d2-4410-91a2',
      loggedIn: true,
      isGenerating: false,
      draftInput: '',
      lastInjectedAt: '就绪',
      turns: [{
        id: 1,
        role: 'user',
        text: '【群聊入群设定协议】你的群昵称是 Claude 3.7（Apple 设计强迫症）',
        time: '00:05'
      }, {
        id: 2,
        role: 'assistant',
        text: '把各个 AI 的浏览器标签页直接内嵌进手机 App 分屏里，比切外部浏览器优雅十倍。',
        time: '00:05'
      }]
    }
  }));
  const bridgeTransportModeRef = useRef(bridgeTransportMode);
  const inAppBrowserTabsRef = useRef(inAppBrowserTabs);
  useEffect(() => {
    bridgeTransportModeRef.current = bridgeTransportMode;
  }, [bridgeTransportMode]);
  useEffect(() => {
    inAppBrowserTabsRef.current = inAppBrowserTabs;
  }, [inAppBrowserTabs]);

  // Appearance & Personalization State
  const [islandColorId, setIslandColorId] = useState(() => initialSavedState?.islandColorId || 'obsidian');
  const [islandIntensity, setIslandIntensity] = useState(() => initialSavedState?.islandIntensity || 'balanced');
  const activeChainRef = useRef(new Map()); // groupId -> { chain: string[], step: number }
  const coAnswerTrackerRef = useRef(new Map()); // dispatchBatchId -> { groupId, total, participatingIds, completedRound1: Set, round2Triggered, completedRound2: Set }
  const [islandCustomBg, setIslandCustomBg] = useState(() => initialSavedState?.islandCustomBg || '#141824');
  const [islandCustomBorder, setIslandCustomBorder] = useState(() => initialSavedState?.islandCustomBorder || '#38bdf8');
  const [themeId, setThemeId] = useState(() => initialSavedState?.themeId || 'apple-light');
  const [bubbleStyleId, setBubbleStyleId] = useState(() => initialSavedState?.bubbleStyleId || 'imessage');
  const [myBubbleColorId, setMyBubbleColorId] = useState(() => initialSavedState?.myBubbleColorId || 'apple-blue');
  const [myBubbleCustomBg, setMyBubbleCustomBg] = useState(() => initialSavedState?.myBubbleCustomBg || '#007AFF');
  const [myBubbleCustomText, setMyBubbleCustomText] = useState(() => initialSavedState?.myBubbleCustomText || '#FFFFFF');
  const [botBubbleMode, setBotBubbleMode] = useState(() => initialSavedState?.botBubbleMode || 'adaptive'); // 'adaptive' | 'role-tinted' | 'frosted-glass' | 'custom'
  const [botBubbleCustomBg, setBotBubbleCustomBg] = useState(() => initialSavedState?.botBubbleCustomBg || '#FFFFFF');
  const [botBubbleCustomText, setBotBubbleCustomText] = useState(() => initialSavedState?.botBubbleCustomText || '#18181B');
  const [avatarShape, setAvatarShape] = useState(() => initialSavedState?.avatarShape || 'rounded-2xl'); // 'rounded-2xl' | 'rounded-full' | 'rounded-lg'
  const [windowLayoutMode, setWindowLayoutMode] = useState('unified'); // 'unified' (一体式真圆角无外框) | 'floating' (分栏内嵌卡片)
  const [isWindowMaximized, setIsWindowMaximized] = useState(true);
  const [isMinimizedToIsland, setIsMinimizedToIsland] = useState(false);
  const getTodayDateStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const safeGetStorage = (k, defVal) => {
    try {
      const v = window.localStorage.getItem(k);
      return v !== null ? v : defVal;
    } catch (_e) {
      return defVal;
    }
  };
  const [islandTopOffset, setIslandTopOffset] = useState(() => Number(safeGetStorage('webh_island_top', 12)));
  const [islandWidth, setIslandWidth] = useState(() => Number(safeGetStorage('webh_island_width', 252)));
  const [islandHeight, setIslandHeight] = useState(() => Number(safeGetStorage('webh_island_height', 46)));
  const [islandGradientMode, setIslandGradientMode] = useState(() => safeGetStorage('chath_island_grad_mode', 'basic')); // 'basic' (从左到右) | 'advanced' (从上到下·顶部纯黑包裹摄像头)
  const [islandGlowEnabled, setIslandGlowEnabled] = useState(() => safeGetStorage('webh_island_glow', 'true') !== 'false');
  const [islandBreathLevel, setIslandBreathLevel] = useState(() => Number(safeGetStorage('webh_island_breath', 55)));
  const [topActionBtnSize, setTopActionBtnSize] = useState(() => Number(safeGetStorage('webh_top_btn_size', 40)));
  const [chatTopMenuOpen, setChatTopMenuOpen] = useState(false);
  const [uploadMenuOpen, setUploadMenuOpen] = useState(false);
  const [appFontFamily, setAppFontFamily] = useState(() => safeGetStorage('webh_font_family', 'system'));
  const [appFontSize, setAppFontSize] = useState(() => Number(safeGetStorage('webh_font_size', 14)));

  // 聊天界面：搜索历史消息弹窗（支持关键词 + 指定日期筛选） & 置顶/标记折叠查看中心弹窗
  const [chatSearchModalOpen, setChatSearchModalOpen] = useState(false);
  const [chatSearchKeyword, setChatSearchKeyword] = useState('');
  const [chatSearchDate, setChatSearchDate] = useState('');
  const [pinsMarksModalOpen, setPinsMarksModalOpen] = useState(false);
  const [pinsMarksFilterTab, setPinsMarksFilterTab] = useState('all'); // 'all' | 'pin' | 'mark'
  const [expandedViewItemIds, setExpandedViewItemIds] = useState([]);
  const RAIN_CITY_BG_URL = "data:image/jpeg;base64,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";
  const DROPLET_TEXTURES = {
    'rain-streaks': "data:image/png;base64,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",
    'macro-dew': "data:image/png;base64,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",
    'fine-mist': "data:image/png;base64,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",
    'none': ''
  };

  // 液态水珠玻璃质感 & 群与游标背景 & 分群聊独立背景状态
  const [liquidGlassLevel, setLiquidGlassLevel] = useState(() => Number(safeGetStorage('chath_liquid_glass_level', 82)));
  const [liquidDropletType, setLiquidDropletType] = useState(() => safeGetStorage('chath_droplet_type', 'rain-streaks')); // 'rain-streaks' | 'macro-dew' | 'fine-mist' | 'none'
  const [liquidDropletOpacity, setLiquidDropletOpacity] = useState(() => Number(safeGetStorage('chath_droplet_opacity', 88)));
  const [groupsBgMode, setGroupsBgMode] = useState(() => safeGetStorage('chath_groups_bg_mode', 'recent-chat')); // 'recent-chat' | 'rain-city' | 'ocean-aurora' | 'neon-night' | 'custom'
  const [groupsCustomBgUrl, setGroupsCustomBgUrl] = useState(() => safeGetStorage('chath_groups_custom_bg', ''));
  const [selectedWallpaperGroupId, setSelectedWallpaperGroupId] = useState('group-1');
  const [groupWallpapers, setGroupWallpapers] = useState(() => {
    try {
      const raw = window.localStorage.getItem('chath_group_wallpapers');
      return raw ? JSON.parse(raw) : {};
    } catch (_e) {
      return {};
    }
  });
  const [themeColorMode, setThemeColorMode] = useState(() => safeGetStorage('chath_theme_color_mode', 'gradient')); // 'basic' (基础款) | 'gradient' (渐变款)

  // 多巴胺明亮浅色主题判定（鲜橙、亮紫、青蓝、火红、碧绿）：在外观工坊中强制采用清晰易读的高对比深色字体！
  const isLightDopamineTheme = ['dopamine-orange', 'dopamine-bright-purple', 'dopamine-cyan-blue', 'dopamine-fire-red', 'dopamine-emerald'].includes(themeId);
  const groupsBgFileInputRef = useRef(null);
  const chatBgFileInputRef = useRef(null);
  useEffect(() => {
    try {
      window.localStorage.setItem('chath_liquid_glass_level', String(liquidGlassLevel));
      window.localStorage.setItem('chath_droplet_type', liquidDropletType);
      window.localStorage.setItem('chath_droplet_opacity', String(liquidDropletOpacity));
      window.localStorage.setItem('chath_groups_bg_mode', groupsBgMode);
      window.localStorage.setItem('chath_theme_color_mode', themeColorMode);
      window.localStorage.setItem('chath_group_wallpapers', JSON.stringify(groupWallpapers));
    } catch (_e) {}
  }, [liquidGlassLevel, liquidDropletType, liquidDropletOpacity, groupsBgMode, themeColorMode, groupWallpapers]);
  const handleUploadGroupsBgFile = e => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const blobUrl = URL.createObjectURL(file);
    setGroupsCustomBgUrl(blobUrl);
    setGroupsBgMode('custom');
    showToast('已更换「群与游标」自定义背景图');
  };
  const handleUploadGroupChatBgFile = e => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const blobUrl = URL.createObjectURL(file);
    const targetGid = selectedWallpaperGroupId || activeGroupId;
    setGroupWallpapers(prev => ({
      ...prev,
      [targetGid]: {
        ...(prev[targetGid] || {}),
        bgMode: 'custom',
        customUrl: blobUrl,
        liquidEnabled: true
      }
    }));
    showToast('已更换该群聊的专属背景图并开启液态水珠玻璃');
  };
  const getWallpaperCssForMode = (mode, customUrl) => {
    if (mode === 'rain-city') return `url("${RAIN_CITY_BG_URL}") center/cover no-repeat`;
    if (mode === 'ocean-aurora') return 'linear-gradient(155deg, #031126 0%, #0369a1 48%, #0d9488 100%)';
    if (mode === 'neon-night') return 'linear-gradient(155deg, #130726 0%, #6d28d9 45%, #db2777 100%)';
    if (mode === 'emerald-dew') return 'linear-gradient(155deg, #031c16 0%, #059669 50%, #10b981 100%)';
    if (mode === 'custom' && customUrl) return `url("${customUrl}") center/cover no-repeat`;
    return null;
  };

  // iOS 26 苹果液态玻璃卡片内联样式（高透折射 + 3D 弧面边缘高光，完全透出后方自然水珠与底图！）
  const getAppleLiquidGlassCardStyle = (extraAlpha = 0) => {
    const t = Math.max(0, Math.min(100, liquidGlassLevel)) / 100;
    const fillAlpha = Math.min(0.62, (darkMode ? 0.16 : 0.14) + t * 0.22 + extraAlpha);
    const blurPx = (1.5 + t * 11).toFixed(1);
    const satPct = Math.round(115 + t * 75);
    const rimHi = (0.35 + t * 0.60).toFixed(2);
    const rimLo = (0.18 + t * 0.36).toFixed(2);
    return {
      background: darkMode ? `linear-gradient(135deg, rgba(255,255,255,${(fillAlpha * 0.85).toFixed(2)}) 0%, rgba(15,23,42,${(fillAlpha * 1.1).toFixed(2)}) 55%, rgba(255,255,255,${(fillAlpha * 0.65).toFixed(2)}) 100%)` : `linear-gradient(135deg, rgba(255,255,255,${(fillAlpha + 0.12).toFixed(2)}) 0%, rgba(255,255,255,${(fillAlpha * 0.55).toFixed(2)}) 52%, rgba(240,249,255,${(fillAlpha + 0.08).toFixed(2)}) 100%)`,
      backdropFilter: `blur(${blurPx}px) saturate(${satPct}%) contrast(104%)`,
      WebkitBackdropFilter: `blur(${blurPx}px) saturate(${satPct}%) contrast(104%)`,
      borderColor: `rgba(255, 255, 255, ${(0.28 + t * 0.52).toFixed(2)})`,
      boxShadow: `inset 0 1.5px 2px rgba(255,255,255,${rimHi}), inset 0 -2px 4px rgba(255,255,255,${rimLo}), inset 1.5px 0 3px rgba(255,255,255,${rimLo}), inset -1.5px 0 3px rgba(255,255,255,${rimLo}), 0 14px 32px rgba(0, 0, 0, ${(0.12 + t * 0.16).toFixed(2)})`
    };
  };
  const composerInputRef = useRef(null);
  const filePickerInputRef = useRef(null);

  // 仅记忆一次、不占用手机闪存的纯内存 AI 回复与多媒体暂存槽
  const ephemeralAiClipRef = useRef(null);
  const [hasEphemeralAiClip, setHasEphemeralAiClip] = useState(false);
  const storeOneTimeEphemeralAiCopy = clipPayload => {
    ephemeralAiClipRef.current = clipPayload;
    setHasEphemeralAiClip(Boolean(clipPayload));
  };
  const consumeOneTimeEphemeralAiCopyToChat = async () => {
    setUploadMenuOpen(false);
    let clip = ephemeralAiClipRef.current;
    ephemeralAiClipRef.current = null;
    setHasEphemeralAiClip(false);
    if (!clip) {
      try {
        if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
          const clipText = (await navigator.clipboard.readText()) || '';
          if (clipText.trim()) {
            clip = {
              botId: activeWebViewBotId || 'deepseek',
              text: clipText.trim(),
              attachments: []
            };
            try {
              await navigator.clipboard.writeText('');
            } catch (_e) {}
          }
        }
      } catch (_e) {}
    }
    if (!clip || !clip.text && (!clip.attachments || clip.attachments.length === 0)) {
      showToast('当前没有待接收的单次 AI 复制内容（请先在内嵌网页点击「复制AI回复/媒体」或复制网页内容）');
      return;
    }
    const bot = botsRef.current.find(b => b.id === clip.botId) || botsRef.current[0];
    const currentMsgs = groupMessagesRef.current[activeGroupId] || messages;
    const nextId = currentMsgs.reduce((maxId, m) => Math.max(maxId, m.id || 0), 0) + 1;
    const now = new Date();
    const newMsg = {
      id: nextId,
      senderId: bot.id,
      senderName: bot.name,
      text: clip.text || '',
      attachments: (clip.attachments || []).map(a => ({
        ...a,
        ephemeralInMemoryOnly: true
      })),
      date: getTodayDateStr(),
      time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
      syncedTo: [bot.id],
      ephemeralInMemoryOnly: true,
      deltaPayload: '来自原网页单次复制（仅内存瞬时显示·零闪存占用）'
    };
    updateGroupMessages([...currentMsgs, newMsg], activeGroupId);
    showToast(`已接收 ${bot.name} 的网页回复与媒体（已清空单次记忆缓存，零内存残留）`);
  };

  // 📌 置顶消息单次全量推送引擎：
  // 仅在「1. 第一次置顶或置顶内容更新时」或「2. 某个 AI 新加入群聊时」向对应 AI 发送一次完整置顶消息全文（突破普通消息长度限制，不重复发送！）
  const notifyBotsOfPinnedMessagesOnce = (groupId, nextPinnedIds, specificBotIds = null) => {
    const cleanPinIds = Array.from(new Set(nextPinnedIds || [])).sort((a, b) => a - b);
    if (cleanPinIds.length === 0) return;
    const pinSignature = cleanPinIds.join(',');
    const allMsgs = groupMessagesRef.current[groupId] || [];
    const pinnedMsgs = allMsgs.filter(m => cleanPinIds.includes(m.id));
    if (pinnedMsgs.length === 0) return;
    const grp = groupsRef.current.find(g => g.id === groupId);
    const candidateBotIds = specificBotIds || grp?.memberIds || [];
    const prevNotifiedMap = {
      ...(groupStatesRef.current[groupId]?.pinnedNotifiedByBot || {})
    };
    const botsToNotify = candidateBotIds.map(id => botsRef.current.find(b => b.id === id)).filter(b => b && prevNotifiedMap[b.id] !== pinSignature);
    if (botsToNotify.length === 0) return;
    const fullPinAnnouncement = `📌【群聊置顶消息通知（完整未截断全文 · 仅在首次置顶/更新或新成员入群时推送一次，请完整阅读）】：\n` + pinnedMsgs.map((m, idx) => `【置顶 #${idx + 1}｜${m.senderName} · ${m.date || '2026-11-03'} ${m.time}】：${m.text || '（媒体附件）'}`).join('\n---\n');
    const nowTime = new Date().toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    });
    const nextNotifiedMap = {
      ...prevNotifiedMap
    };
    botsToNotify.forEach(b => {
      nextNotifiedMap[b.id] = pinSignature;
    });
    updateGroupState(groupId, state => ({
      ...state,
      pinnedMessageIds: cleanPinIds,
      pinnedNotifiedByBot: nextNotifiedMap
    }));
    setInAppBrowserTabs(prev => {
      const nextTabs = {
        ...prev
      };
      botsToNotify.forEach(b => {
        const bUrl = (b.targetUrl || 'https://chat.deepseek.com/').trim();
        const cur = nextTabs[b.id] || {
          url: bUrl,
          browsingUrl: null,
          loggedIn: true,
          isGenerating: false,
          draftInput: '',
          turns: [],
          sessionsByUrl: {}
        };
        const sessions = {
          ...(cur.sessionsByUrl || {})
        };
        const prevTurns = sessions[bUrl] || cur.turns || [];
        const pinTurn = {
          id: Date.now() + Math.floor(Math.random() * 1000),
          role: 'user',
          text: fullPinAnnouncement,
          time: nowTime
        };
        const ackTurn = {
          id: Date.now() + Math.floor(Math.random() * 1000) + 1,
          role: 'assistant',
          text: `✅ 已完整接收本群 ${pinnedMsgs.length} 条置顶消息全文（共 ${fullPinAnnouncement.length} 字，突破常规单条字数上限，已记入长期上下文，后续无需重复发送）。`,
          time: nowTime
        };
        const updatedTurns = [...prevTurns.slice(-12), pinTurn, ackTurn];
        sessions[bUrl] = updatedTurns;
        nextTabs[b.id] = {
          ...cur,
          sessionsByUrl: sessions,
          turns: updatedTurns
        };
      });
      return nextTabs;
    });
    const notifiedNames = botsToNotify.map(b => b.name.split(' ')[0]).join('、');
    triggerIslandAlert(`📌 置顶消息已单次全量推送`, `已向 ${notifiedNames} 发送完整置顶全文（仅推送一次）`, 'PIN', 'from-amber-500 to-orange-600', 2800);
    showToast(`📌 已向「${notifiedNames}」完整推送置顶消息（突破长消息限制，仅发送一次）`);
  };
  useEffect(() => {
    try {
      window.localStorage.setItem('webh_island_top', String(islandTopOffset));
      window.localStorage.setItem('webh_island_width', String(islandWidth));
      window.localStorage.setItem('webh_island_height', String(islandHeight));
      window.localStorage.setItem('chath_island_grad_mode', islandGradientMode);
      window.localStorage.setItem('webh_island_glow', String(islandGlowEnabled));
      window.localStorage.setItem('webh_island_breath', String(islandBreathLevel));
      window.localStorage.setItem('webh_top_btn_size', String(topActionBtnSize));
      window.localStorage.setItem('webh_font_family', appFontFamily);
      window.localStorage.setItem('webh_font_size', String(appFontSize));
    } catch (_e) {}
  }, [islandTopOffset, islandWidth, islandHeight, islandGradientMode, islandGlowEnabled, islandBreathLevel, topActionBtnSize, appFontFamily, appFontSize]);
  const getAppFontFamilyCss = () => {
    if (appFontFamily === 'rounded') return '"SF Pro Rounded", "Hiragino Maru Gothic ProN", "YouYuan", "PingFang SC", system-ui, sans-serif';
    if (appFontFamily === 'serif') return '"Songti SC", "Noto Serif CJK SC", "STSong", Georgia, serif';
    if (appFontFamily === 'mono') return '"JetBrains Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace';
    return '-apple-system, BlinkMacSystemFont, "PingFang SC", "SF Pro Text", "Inter", system-ui, sans-serif';
  };

  // 灵动岛主题色彩矩阵：同时支持三档渐变强度 (subtle / balanced / vibrant) 与两种渐变方向模式：
  // - 基础模式 ('basic')：从左到右 (90deg)，从黑/深底过渡到选定主题色
  // - 进阶模式 ('advanced')：从上到下 (180deg)，顶部纯黑 (#000000) 完美包裹手机自拍摄像头，向下柔和过渡到选定主题色！
  const getIslandThemeBackgroundCss = (presetId = islandColorId, intensity = islandIntensity, gradMode = islandGradientMode, customBg = islandCustomBg) => {
    const stopsByPreset = {
      obsidian: {
        subtle: ['#06070a', '#12151e', '#1c2230'],
        balanced: ['#05070e', '#161f33', '#24304d'],
        vibrant: ['#05070e', '#1e2946', '#334675']
      },
      'glacier-light': {
        subtle: ['#f8fafc', '#eef2f9', '#e2e8f0'],
        balanced: ['#ffffff', '#e0f2fe', '#dbeafe'],
        vibrant: ['#ffffff', '#bae6fd', '#c7d2fe']
      },
      'ocean-blue': {
        subtle: ['#040914', '#0c2147', '#15346b'],
        balanced: ['#030b1c', '#0369a1', '#1e40af'],
        vibrant: ['#020817', '#0284c7', '#2563eb']
      },
      'cyber-purple': {
        subtle: ['#0a0414', '#241042', '#3b1566'],
        balanced: ['#0b0314', '#7e22ce', '#c026d3'],
        vibrant: ['#090212', '#9333ea', '#ec4899']
      },
      'emerald-jade': {
        subtle: ['#030d0a', '#0a2e24', '#0f4737'],
        balanced: ['#020b08', '#047857', '#0f766e'],
        vibrant: ['#020a07', '#059669', '#10b981']
      },
      'sunset-amber': {
        subtle: ['#120904', '#30190b', '#54280e'],
        balanced: ['#120702', '#c2410c', '#b45309'],
        vibrant: ['#140702', '#ea580c', '#f59e0b']
      },
      'rose-velvet': {
        subtle: ['#12040a', '#380e20', '#591230'],
        balanced: ['#140309', '#be123c', '#9f1239'],
        vibrant: ['#170209', '#e11d48', '#fb7185']
      },
      'vision-spectrum': {
        subtle: ['#060911', '#1a233a', '#263457'],
        balanced: ['#060913', '#1d4ed8', '#be185d'],
        vibrant: ['#050811', '#2563eb', '#ec4899']
      }
    };
    const [cStart, cMid, cEnd] = presetId === 'custom' ? ['#050608', customBg || '#1d4ed8', customBg || '#38bdf8'] : stopsByPreset[presetId]?.[intensity] || stopsByPreset.obsidian[intensity] || stopsByPreset.obsidian.balanced;
    if (gradMode === 'advanced') {
      // 进阶模式：从上到下 (180deg)，上方 0%~42% 纯黑包裹手机前置摄像头，下方渐变到选定颜色！
      return `linear-gradient(180deg, #000000 0%, #030306 42%, ${cMid} 74%, ${cEnd} 100%)`;
    }
    // 基础模式：从左到右 (90deg)，从黑/起点色过渡到选定颜色
    return `linear-gradient(90deg, ${cStart} 0%, ${cMid} 52%, ${cEnd} 100%)`;
  };
  const getIslandGlowColorHex = () => {
    if (islandColorId === 'custom') return islandCustomBorder || '#38bdf8';
    const map = {
      obsidian: '#60a5fa',
      'glacier-light': '#38bdf8',
      'ocean-blue': '#38bdf8',
      'cyber-purple': '#c084fc',
      'emerald-jade': '#34d399',
      'sunset-amber': '#fbbf24',
      'rose-velvet': '#fb7185',
      'vision-spectrum': '#a855f7'
    };
    return map[islandColorId] || '#38bdf8';
  };
  const webViewRenderModeRef = useRef(webViewRenderMode);
  useEffect(() => {
    webViewRenderModeRef.current = webViewRenderMode;
  }, [webViewRenderMode]);
  useEffect(() => {
    if (!window.AndroidWebHBridge || typeof window.AndroidWebHBridge.postCommand !== 'function') return;
    const targetBot = bots.find(b => b.id === activeWebViewBotId) || bots[0];
    if (webViewRenderMode === 'native-iframe' && activeTab === 'webview' && !isMinimizedToIsland) {
      const topOffset = islandTopOffset + islandHeight + 56;
      const viewHeight = Math.max(240, Math.round(window.innerHeight - topOffset - 62));
      try {
        window.AndroidWebHBridge.postCommand(JSON.stringify({
          action: 'SHOW_EMBEDDED_WEBVIEW',
          botId: activeWebViewBotId,
          targetUrl: targetBot?.targetUrl || 'https://chat.deepseek.com',
          topPx: Math.round(topOffset * (window.devicePixelRatio || 1)),
          heightPx: Math.round(viewHeight * (window.devicePixelRatio || 1))
        }));
      } catch (_e) {}
    } else {
      try {
        window.AndroidWebHBridge.postCommand(JSON.stringify({
          action: 'HIDE_EMBEDDED_WEBVIEW'
        }));
      } catch (_e) {}
    }
  }, [webViewRenderMode, activeTab, activeWebViewBotId, isMinimizedToIsland, bots, islandTopOffset, islandHeight]);

  // User ("Me") Profile & Avatar State
  const [myProfile, setMyProfile] = useState(() => initialSavedState?.myProfile || {
    name: '我 (主理人)',
    badge: '我',
    avatarType: 'badge',
    // 'badge' | 'emoji' | 'image'
    emoji: '🧑‍💻',
    imageUrl: '',
    avatarBg: 'from-blue-600 via-indigo-500 to-violet-600',
    customColor: ''
  });
  const [selectedAvatarTarget, setSelectedAvatarTarget] = useState('me'); // 'me' or bot.id
  const [selectedBubbleBotId, setSelectedBubbleBotId] = useState(() => (initialSavedState?.bots || INITIAL_BOTS)[0]?.id || 'deepseek');
  const chatEndRef = useRef(null);
  const searchInputRef = useRef(null);
  const skipFirstSaveEffectRef = useRef(true);
  const messageElementRefs = useRef(new Map());
  const wsRef = useRef(null);
  const promptVariantCounterRef = useRef(0);
  const islandTimerRef = useRef(null);
  const groupMessagesRef = useRef(groupMessages);
  const groupStatesRef = useRef(groupStates);
  const groupsRef = useRef(groups);
  const activeGroupIdRef = useRef(activeGroupId);
  const activeTabRef = useRef(activeTab);
  const botsRef = useRef(bots);
  const personaModesRef = useRef(personaModes);
  const featureSettingsRef = useRef(featureSettings);
  const botDispatchStatesRef = useRef(new Map());
  const botRequestSequenceRef = useRef(0);
  const cancelledRequestIdsRef = useRef(new Set());
  const autopilotStartupRef = useRef(new Set());
  const activeRacesRef = useRef(new Map());
  const messageStartWinnersRef = useRef(new Map());
  const pendingEmergencyStopsRef = useRef(new Set());
  const emergencyStopGroupsRef = useRef(new Set());
  const bridgeWarningShownRef = useRef(false);
  const wsUrlRef = useRef(wsUrl);
  const snapshotRef = useRef(initialSavedState || null);
  const persistenceQueueRef = useRef(Promise.resolve());
  const triggerIslandAlert = (title, subtitle, badgeText = 'LIVE', avatarBg = 'from-[#0052FF] via-[#0080FF] to-[#6366F1]', duration = 3200) => {
    if (islandTimerRef.current) clearTimeout(islandTimerRef.current);
    setIslandEvent({
      title,
      subtitle,
      badgeText,
      avatarBg
    });
    setToast(title);
    islandTimerRef.current = setTimeout(() => {
      setIslandEvent(null);
      setToast(null);
    }, duration);
  };
  const showToast = msg => {
    triggerIslandAlert(msg, '系统状态实时通知', 'OK', 'from-emerald-400 to-teal-600', 2600);
  };
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({
      behavior: 'smooth'
    });
  }, [messages, typingBots]);
  useEffect(() => {
    const handleKeyDown = event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setShowLeftSidebar(true);
        setIsMinimizedToIsland(false);
        setTimeout(() => searchInputRef.current?.focus(), 50);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);
  useEffect(() => {
    groupMessagesRef.current = groupMessages;
  }, [groupMessages]);
  useEffect(() => {
    groupStatesRef.current = groupStates;
  }, [groupStates]);
  useEffect(() => {
    groupsRef.current = groups;
  }, [groups]);
  useEffect(() => {
    activeGroupIdRef.current = activeGroupId;
  }, [activeGroupId]);
  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);
  useEffect(() => {
    botsRef.current = bots;
  }, [bots]);
  useEffect(() => {
    personaModesRef.current = personaModes;
  }, [personaModes]);
  useEffect(() => {
    featureSettingsRef.current = featureSettings;
  }, [featureSettings]);
  const updateGroupState = (groupId, update) => {
    const current = groupStatesRef.current || {};
    const previous = createDefaultGroupState(current[groupId] || {}, botsRef.current, groupId);
    const nextValue = typeof update === 'function' ? update(previous) : update;
    const next = {
      ...current,
      [groupId]: nextValue
    };
    groupStatesRef.current = next;
    setGroupStates(next);
  };
  const updateGroupMessages = (update, groupId = activeGroupId) => {
    const previous = groupMessagesRef.current || groupMessages;
    const current = previous[groupId] || [];
    const nextMessages = typeof update === 'function' ? update(current) : update;
    const nextMap = {
      ...previous,
      [groupId]: nextMessages
    };
    groupMessagesRef.current = nextMap;
    setGroupMessages(nextMap);
    if (nextMessages.length > 0) {
      const latestMsg = nextMessages[nextMessages.length - 1];
      const latestSubtitle = latestMsg.type === 'conclusion-card' ? '📊 讨论已出结论' : `${(latestMsg.senderName || '').split(' ')[0]}: ${latestMsg.text || '图片/视频'}`;
      setGroups(prevGroups => prevGroups.map(g => g.id === groupId ? {
        ...g,
        time: latestMsg.time || g.time,
        subtitle: latestSubtitle
      } : g));
    }
    const unreadAdded = nextMessages.filter(message => message.senderId !== 'me' && message.type !== 'conclusion-card' && !current.some(existing => existing.id === message.id)).length;
    if (unreadAdded && (groupId !== activeGroupIdRef.current || activeTabRef.current !== 'chat')) {
      updateGroupState(groupId, state => ({
        ...state,
        unreadCount: (state.unreadCount || 0) + unreadAdded
      }));
    }
  };
  const getCursorForBot = (botId, groupId = activeGroupId) => {
    const bot = botsRef.current.find(item => item.id === botId);
    if (!bot) return 0;
    const isolatedCursor = groupStatesRef.current[groupId]?.syncCursors?.[botId];
    return Number.isFinite(isolatedCursor) ? isolatedCursor : bot.syncCursorByGroup?.[groupId] ?? (groupId === 'group-1' ? bot.syncCursor : 0);
  };
  const updateBotCursor = (botId, groupId, cursor) => {
    updateGroupState(groupId, state => ({
      ...state,
      syncCursors: {
        ...state.syncCursors,
        [botId]: Math.max(state.syncCursors?.[botId] || 0, cursor || 0)
      }
    }));
    const nextBots = botsRef.current.map(bot => {
      if (bot.id !== botId) return bot;
      const previousCursor = bot.syncCursorByGroup?.[groupId] ?? (groupId === 'group-1' ? bot.syncCursor : 0);
      const nextCursor = Math.max(previousCursor || 0, cursor || 0);
      return {
        ...bot,
        syncCursor: groupId === 'group-1' ? nextCursor : bot.syncCursor,
        syncCursorByGroup: {
          ...(bot.syncCursorByGroup || {}),
          [groupId]: nextCursor
        }
      };
    });
    botsRef.current = nextBots;
    setBots(nextBots);
  };
  const resetBotCursor = (botId, groupId = activeGroupId) => {
    updateGroupState(groupId, state => ({
      ...state,
      syncCursors: {
        ...state.syncCursors,
        [botId]: 0
      }
    }));
    const nextBots = botsRef.current.map(bot => bot.id === botId ? {
      ...bot,
      syncCursor: groupId === 'group-1' ? 0 : bot.syncCursor,
      syncCursorByGroup: {
        ...(bot.syncCursorByGroup || {}),
        [groupId]: 0
      }
    } : bot);
    botsRef.current = nextBots;
    setBots(nextBots);
    const targetBot = botsRef.current.find(b => b.id === botId);
    showToast(`已将 ${targetBot?.name || 'AI'} 在本群的同步游标重置为 0`);
  };
  const activeGroup = groups.find(group => group.id === activeGroupId) || groups[0];
  const activeBots = bots.filter(bot => activeGroup?.memberIds?.includes(bot.id));
  const activeGroupState = groupStates[activeGroupId] || createDefaultGroupState({}, bots, activeGroupId);
  const activeAutoPilot = activeGroupState.autoPilot;
  const activePersonaMode = personaModes.find(persona => persona.id === activeGroupState.activePersonaId) || null;
  const personaEditorBot = bots.find(bot => bot.id === personaEditorBotId);

  // 引用权限判断辅助函数：支持「都可引用 / 仅我可引用 / 仅AI可引用 / 部分引用 / 全部关闭」
  const canMeQuote = () => {
    const perm = featureSettingsRef.current.quotePermission || (featureSettingsRef.current.quoteReplies === false ? 'off' : 'both');
    if (perm === 'off' || perm === 'ai-only') return false;
    if (perm === 'partial') return featureSettingsRef.current.partialAllowMe !== false;
    return true;
  };
  const canBotQuote = botId => {
    const perm = featureSettingsRef.current.quotePermission || (featureSettingsRef.current.quoteReplies === false ? 'off' : 'both');
    if (perm === 'off' || perm === 'me-only') return false;
    if (perm === 'partial') {
      const allowed = Array.isArray(featureSettingsRef.current.partialAllowedBotIds) ? featureSettingsRef.current.partialAllowedBotIds : botsRef.current.map(b => b.id);
      return allowed.includes(botId);
    }
    return true;
  };
  const resolveBotQuotedMessage = (botId, currentMessages = [], groupId = activeGroupId) => {
    if (!canBotQuote(botId)) return null;
    const perm = featureSettingsRef.current.quotePermission || 'both';
    const quoteMode = featureSettingsRef.current.quoteMode || 'smart';
    if (quoteMode === 'off') return null;
    const targetFilter = perm === 'partial' ? featureSettingsRef.current.quoteTargetFilter || 'all' : 'all';
    const pinnedIds = groupStatesRef.current[groupId]?.pinnedMessageIds || [];
    const maxLen = Number(featureSettingsRef.current.quoteMaxLength) || 80;
    const isEligibleTarget = msg => {
      if (!msg || msg.senderId === botId || msg.type === 'conclusion-card' || !msg.text && !msg.attachments?.length) return false;
      if (targetFilter === 'ai-only') return msg.senderId !== 'me';
      if (targetFilter === 'me-only') return msg.senderId === 'me';
      if (targetFilter === 'pinned-only') return pinnedIds.includes(msg.id);
      return true;
    };
    const formatCandidate = msg => {
      if (!msg) return null;
      const forwardTag = msg.forwardedFrom ? `[转自「${msg.forwardedFrom.groupName}」${msg.forwardedFrom.senderName}] ` : '';
      return {
        id: msg.id,
        senderName: msg.senderName,
        text: `${forwardTag}${msg.text || '图片/视频'}`.slice(0, maxLen)
      };
    };
    if (quoteMode === 'always') {
      const found = [...currentMessages].reverse().find(isEligibleTarget);
      return formatCandidate(found);
    }
    if (quoteMode === 'mention-or-pin') {
      const lastMsg = [...currentMessages].reverse().find(isEligibleTarget);
      if (!lastMsg) return null;
      const botObj = botsRef.current.find(b => b.id === botId);
      const isMentioned = botObj ? findMentionedBots(lastMsg.text || '', [botObj]).length > 0 : false;
      const isPinned = pinnedIds.includes(lastMsg.id);
      return isMentioned || isPinned ? formatCandidate(lastMsg) : null;
    }
    // 默认 'smart' 智能模式：上一条发言来自其他 AI、或带有跨群转发来源、或命中过滤条件时自动挂引用
    const lastMsg = currentMessages[currentMessages.length - 1];
    if (!lastMsg || !isEligibleTarget(lastMsg)) return null;
    if (targetFilter === 'me-only' || targetFilter === 'pinned-only' || lastMsg.senderId !== 'me' || lastMsg.forwardedFrom) {
      return formatCandidate(lastMsg);
    }
    return null;
  };
  const getUnreadMessagesForBot = (botId, currentMsgs = messages, groupId = activeGroupId) => {
    const cursor = getCursorForBot(botId, groupId);
    // 关键保障：若消息带有 forwardedFrom（由主理人跨群转发进本群），即使原发言人与当前群某 AI 同 ID，也必须作为新未读消息同步给本群该 AI！
    return (currentMsgs || groupMessagesRef.current[groupId] || []).filter(message => message.id > cursor && (Boolean(message.forwardedFrom) || message.senderId !== botId));
  };
  const getPersonaSignature = bot => `${bot.targetUrl || ''}\u241f${bot.name || ''}\u241f${bot.roleTag || ''}\u241f${bot.persona || ''}`;
  const shouldRefreshPersona = (bot, groupId, signature = getPersonaSignature(bot)) => {
    const previous = bot.personaSyncByGroup?.[groupId];
    return !previous || previous.signature !== signature || Date.now() - previous.at >= PERSONA_REMINDER_INTERVAL_MS;
  };
  const markPersonaSynced = (botId, groupId, signature) => {
    if (!signature) return;
    const nextBots = botsRef.current.map(bot => bot.id === botId ? {
      ...bot,
      personaSyncByGroup: {
        ...(bot.personaSyncByGroup || {}),
        [groupId]: {
          signature,
          at: Date.now()
        }
      }
    } : bot);
    botsRef.current = nextBots;
    setBots(nextBots);
  };
  const buildIncrementalPayload = (botId, currentMsgs = messages, groupId = activeGroupId, responsePolicy = 'required', force = false, includePersona, options = {}) => {
    const bot = botsRef.current.find(item => item.id === botId);
    if (!bot) return '';
    const unread = getUnreadMessagesForBot(botId, currentMsgs, groupId).filter(message => options.summaryMode || !Number.isFinite(options.maxMessageId) || message.id <= options.maxMessageId);
    const groupName = groupsRef.current.find(group => group.id === groupId)?.name || '群聊';
    if (unread.length === 0) {
      if (!force) return '';
    }
    const maxChars = Number(featureSettingsRef.current.maxContextChars) || 0;
    const pinnedIds = groupStatesRef.current[groupId]?.pinnedMessageIds || [];
    const preserveCode = featureSettingsRef.current.preserveCodeBlocks !== false;

    // 长消息过滤与置顶/转发/代码块透传特权：
    const rawItems = (options.summaryMode ? currentMsgs : unread).filter(m => m.type !== 'conclusion-card').filter(m => {
      if (options.summaryMode || options.coAnswerRound === 1) return true;
      const textStr = String(m.text || '');
      const isPinned = pinnedIds.includes(m.id);
      const isForwarded = Boolean(m.forwardedFrom);
      const hasCodeBlock = preserveCode && /```|function\s+|const\s+|import\s+|Traceback|Error:/i.test(textStr);
      if (maxChars <= 0 || textStr.length <= maxChars || isPinned || isForwarded || hasCodeBlock) return true;
      return false; // 超出阈值且无特权，跳过全量同步
    });

    // 共答模式第一轮特权：第一轮所有 AI 同时只看“我（主理人）”的发言或主理人转发的消息，独立思考各自作答
    const scopedItems = options.coAnswerRound === 1 ? rawItems.filter(m => m.senderId === 'me' || Boolean(m.forwardedFrom)) : rawItems;

    // 合并增量上下文：将同一成员连续发送的多条非转发、非引用消息合并为单个段落
    const mergedItems = [];
    if (featureSettingsRef.current.mergeIncrementalContext && !options.summaryMode) {
      for (const m of scopedItems) {
        const prev = mergedItems[mergedItems.length - 1];
        if (prev && prev.senderId === m.senderId && !m.replyTo && !prev.replyTo && !m.forwardedFrom && !prev.forwardedFrom) {
          prev.text = [prev.text, m.text].filter(Boolean).join(' ； ');
          prev.attachments = [...(prev.attachments || []), ...(m.attachments || [])];
        } else {
          mergedItems.push({
            ...m,
            attachments: [...(m.attachments || [])]
          });
        }
      }
    } else {
      mergedItems.push(...scopedItems);
    }
    const showForwardProvenance = featureSettingsRef.current.forwardWithProvenance !== false;
    const historyLines = mergedItems.map(m => {
      const pinPrefix = '';
      const quotePrefix = m.replyTo ? ` (回应 @${m.replyTo.senderName}「${String(m.replyTo.text || '').replace(/\s+/g, ' ').slice(0, 60)}」)` : '';
      const attachmentSuffix = m.attachments?.length ? `（附 ${m.attachments.length} 个媒体：${m.attachments.map(file => file.name).join('、')}）` : '';
      if (m.forwardedFrom && showForwardProvenance) {
        const originGroup = m.forwardedFrom.groupName || '其他群聊';
        const originSpeaker = m.forwardedFrom.senderName || 'AI 群友';
        const originRole = m.forwardedFrom.roleTag ? ` · ${m.forwardedFrom.roleTag}` : '';
        const originPlatform = m.forwardedFrom.platform ? ` (${m.forwardedFrom.platform})` : '';
        return `${pinPrefix}📨 [转发消息｜来自群聊「${originGroup}」的原发言人「${originSpeaker}${originRole}${originPlatform}」]${quotePrefix}: ${m.text || ''}${attachmentSuffix}`;
      }
      return `${pinPrefix}[${m.senderName}]${quotePrefix}: ${m.text || ''}${attachmentSuffix}`;
    }).join('\n');
    const personaSignature = getPersonaSignature(bot);
    const appendPersona = includePersona ?? shouldRefreshPersona(bot, groupId, personaSignature);
    const variantIdx = featureSettingsRef.current.rotatePromptFingerprints ? promptVariantCounterRef.current++ + (unread[unread.length - 1]?.id || 0) : 0;
    const introLine = NATURAL_HISTORY_INTROS[variantIdx % NATURAL_HISTORY_INTROS.length](groupName);

    // 根据用户设定的单次回复字数档位动态调整收尾指令
    const lengthMode = featureSettingsRef.current.replyLengthMode || 'short-50';
    let closerLine = featureSettingsRef.current.rotatePromptFingerprints ? NATURAL_REPLY_CLOSERS[variantIdx % NATURAL_REPLY_CLOSERS.length] : antiPreachSuffix;
    if (lengthMode === 'medium-120') {
      closerLine = '请顺着上面的话自然接两三句（口语化一点，不用列123点，控制在120字以内）：';
    } else if (lengthMode === 'deep-300') {
      closerLine = '请针对上面的内容展开聊聊你的具体分析或方案（条理清晰但别说官话套话，控制在300字以内）：';
    } else if (lengthMode === 'unlimited') {
      closerLine = '请直接接话详细输出你的完整思考、代码或方案（保持群友交流口吻，不限制字数）：';
    }
    const hasForwardedInBatch = mergedItems.some(m => Boolean(m.forwardedFrom));
    const forwardContextHint = hasForwardedInBatch && showForwardProvenance ? '\n（注：上方标有 📨 的消息是由主理人从其他群聊转发过来的，请结合其原群聊背景与原发言 AI 的身份进行回应或点评）' : '';
    const antiEchoHint = featureSettingsRef.current.antiEchoGuard && mergedItems.some(m => m.senderId !== 'me') ? '\n（注意：请勿顺着上一位 AI 的话做同义复读，直接补充新视角、新方案或指出漏洞）' : '';
    const history = options.summaryMode ? `请帮我把「${groupName}」刚才这几句讨论整理成一页简短结论，只按下面三行输出：\n核心共识：...\n关键分歧点：...\n最终落地建议：...\n\n${historyLines}` : unread.length ? `${introLine}\n${historyLines}` : `请接着刚才「${groupName}」的话题继续聊两句：`;
    const personaReminder = appendPersona ? NATURAL_PERSONA_WRAPPERS[variantIdx % NATURAL_PERSONA_WRAPPERS.length](bot.name, bot.roleTag || '群友', bot.persona || '') : '';
    const groupPersona = groupStatesRef.current[groupId]?.activePersonaId ? personaModesRef.current.find(persona => persona.id === groupStatesRef.current[groupId].activePersonaId) : null;
    const groupPersonaInstruction = groupPersona ? `\n（当前群聊氛围：${groupPersona.name}——${groupPersona.instruction}）` : '';
    const discussionPhase = groupStatesRef.current[groupId]?.autoPilot?.phase;
    const phaseInstruction = featureSettingsRef.current.guidePhases && groupStatesRef.current[groupId]?.autoPilot?.enabled ? `\n（当前节奏：${discussionPhase === 'break-ice' ? '先破冰聊聊直观想法' : discussionPhase === 'challenge' ? '直接指出漏洞或不同看法' : '收敛分歧给出最终拍板建议'}）` : '';
    const handoffContext = options.handoffContext ? `\n\n上一位群友刚提到：「${String(options.handoffContext).slice(0, 800)}」，请自然接话回应：` : '';
    return `${history}${forwardContextHint}${handoffContext}${personaReminder}${groupPersonaInstruction}${phaseInstruction}${antiEchoHint}\n\n${options.summaryMode ? '请直接给出三行总结，不要寒暄或复述原文。' : closerLine}`;
  };
  const mergeDispatchPolicy = (a, b) => {
    const priority = {
      silent: 0,
      optional: 1,
      required: 2
    };
    return (priority[b] || 0) > (priority[a] || 0) ? b : a;
  };
  const finishBotDispatch = (botId, requestId) => {
    const state = botDispatchStatesRef.current.get(botId);
    if (!state || requestId && state.requestId !== requestId) return;
    state.inFlight = false;
    state.requestId = null;
    const next = state.pendingByGroup.entries().next();
    if (!next.done) {
      const [groupId, pending] = next.value;
      const job = pending.jobs?.shift();
      if (pending.jobs?.length) state.pendingByGroup.set(groupId, pending);else state.pendingByGroup.delete(groupId);
      const nextDispatch = job || pending;
      queueMicrotask(() => enqueueBotReply(botId, null, groupId, nextDispatch.policy, nextDispatch.force, nextDispatch.options || {}));
    }
  };
  const enqueueBotReply = (botId, currentMsgsSnapshot, groupId = activeGroupId, responsePolicy = 'required', force = false, options = {}) => {
    const bot = botsRef.current.find(item => item.id === botId);
    if (!bot) return;
    // Web-channel safety: never send silent/non-speaking pings to browser tabs; keep unread cursor local until the bot actually speaks.
    if (responsePolicy === 'silent' && !force && !options.summaryMode) {
      return;
    }
    const brokenReason = groupStatesRef.current[groupId]?.circuitBrokenBots?.[botId];
    if (brokenReason && !options.manualOverride) {
      showToast(`🛡️ ${bot.name} 已触发防封熔断暂停（${brokenReason}），请检查网页后在顶栏或侧栏解除熔断`);
      return;
    }
    let state = botDispatchStatesRef.current.get(botId);
    if (!state) {
      state = {
        inFlight: false,
        requestId: null,
        pendingByGroup: new Map()
      };
      botDispatchStatesRef.current.set(botId, state);
    }
    if (state.inFlight) {
      // 合并增量上下文：当网页忙或排队时，始终将同一群聊的新增消息合并为单次增量包，避免连续刷请求
      const previous = state.pendingByGroup.get(groupId) || {
        policy: responsePolicy,
        force: false,
        options: {}
      };
      if (!featureSettingsRef.current.queueWhileBusy && !featureSettingsRef.current.mergeIncrementalContext) {
        const queuedMessageId = Math.max(0, ...(currentMsgsSnapshot || groupMessagesRef.current[groupId] || []).map(message => message.id || 0));
        const job = {
          policy: responsePolicy,
          force,
          options: {
            ...options,
            maxMessageId: queuedMessageId
          }
        };
        const jobs = previous.jobs ? [...previous.jobs, job] : state.pendingByGroup.has(groupId) ? [previous, job] : [job];
        state.pendingByGroup.set(groupId, {
          jobs
        });
        return;
      }
      state.pendingByGroup.set(groupId, {
        policy: mergeDispatchPolicy(previous.policy, responsePolicy),
        force: previous.force || force,
        options: {
          ...previous.options,
          ...options
        }
      });
      return;
    }
    const currentMsgs = groupMessagesRef.current[groupId] || currentMsgsSnapshot || [];
    const unread = getUnreadMessagesForBot(botId, currentMsgs, groupId).filter(message => options.summaryMode || !Number.isFinite(options.maxMessageId) || message.id <= options.maxMessageId);
    if (!unread.length && !force) {
      if (state.pendingByGroup.size) queueMicrotask(() => finishBotDispatch(botId));
      return;
    }
    const syncThrough = unread.length ? unread[unread.length - 1].id : getCursorForBot(botId, groupId);
    const personaSignature = getPersonaSignature(bot);
    const personaIncluded = shouldRefreshPersona(bot, groupId, personaSignature);
    const payloadToSend = buildIncrementalPayload(botId, currentMsgs, groupId, responsePolicy, force, personaIncluded, options);
    const requestId = `${Date.now()}-${++botRequestSequenceRef.current}`;
    const bridge = wsRef.current;
    const bridgeReady = bridge?.readyState === WebSocket.OPEN;
    if (!bot.targetUrl) {
      updateGroupState(groupId, current => ({
        ...current,
        lastDispatchError: {
          botId,
          message: `${bot.name} 尚未绑定网页对话地址`,
          at: Date.now()
        }
      }));
      setTypingBots(previous => previous.filter(id => id !== botId));
      showToast(`${bot.name} 尚未绑定网页地址，消息已保留为未读`);
      return;
    }
    if (!bridgeReady) {
      const previous = state.pendingByGroup.get(groupId) || {
        policy: responsePolicy,
        force: false,
        options: {}
      };
      state.pendingByGroup.set(groupId, {
        ...previous,
        policy: mergeDispatchPolicy(previous.policy, responsePolicy),
        force: previous.force || force,
        options: {
          ...previous.options,
          ...options
        }
      });
      if (!bridgeWarningShownRef.current) {
        bridgeWarningShownRef.current = true;
        showToast('桥接暂时断开，消息已排队；重新连接后会自动补发');
      }
      return;
    }
    state.inFlight = true;
    state.requestId = requestId;
    state.groupId = groupId;
    state.syncThrough = syncThrough;
    state.responsePolicy = responsePolicy;
    state.force = force;
    state.options = options;
    state.personaSignature = personaIncluded ? personaSignature : null;
    setTypingBots(previous => previous.includes(botId) ? previous : [...previous, botId]);
    triggerIslandAlert(`${bot.name} 已收到 +${unread.length} 条消息`, responsePolicy === 'silent' ? '正在静默同步上下文' : '正在等待网页 AI 回复', bot.badge, bot.avatarBg, 1800);
    if (bridgeReady && bot.targetUrl) {
      try {
        bridge.send(JSON.stringify({
          action: 'SEND_TO_TAB',
          requestId,
          botId: bot.id,
          platform: bot.platform || '',
          targetUrl: bot.targetUrl,
          selectorInput: bot.selectorInput,
          selectorSend: bot.selectorSend,
          payload: payloadToSend,
          attachments: unread.flatMap(message => message.attachments || []),
          groupId,
          syncThrough,
          responsePolicy,
          summaryMode: options.summaryMode === true,
          raceId: options.raceId || null,
          firstTokenTimeoutMs: featureSettingsRef.current.skipStalledTab ? 5_000 : 90_000
        }));
        return;
      } catch (error) {
        state.inFlight = false;
        state.requestId = null;
        const previous = state.pendingByGroup.get(groupId) || {
          policy: responsePolicy,
          force: false,
          options: {}
        };
        state.pendingByGroup.set(groupId, {
          policy: mergeDispatchPolicy(previous.policy, responsePolicy),
          force: previous.force || force,
          options: {
            ...previous.options,
            ...options
          }
        });
        setTypingBots(previous => previous.filter(id => id !== botId));
        setWsConnected(false);
        return;
      }
    }
  };
  const flushQueuedBotDispatches = () => {
    botDispatchStatesRef.current.forEach((state, botId) => {
      if (state.inFlight || !state.pendingByGroup.size) return;
      const next = state.pendingByGroup.entries().next();
      if (next.done) return;
      const [groupId, pending] = next.value;
      const job = pending.jobs?.shift();
      if (pending.jobs?.length) state.pendingByGroup.set(groupId, pending);else state.pendingByGroup.delete(groupId);
      const nextDispatch = job || pending;
      enqueueBotReply(botId, null, groupId, nextDispatch.policy, nextDispatch.force, nextDispatch.options || {});
    });
  };
  const triggerBotReply = (botId, currentMsgsSnapshot, groupId = activeGroupId) => {
    // 手动催更时自动解除该 AI 的熔断锁定
    if (groupStatesRef.current[groupId]?.circuitBrokenBots?.[botId]) {
      updateGroupState(groupId, state => {
        const nextBroken = {
          ...(state.circuitBrokenBots || {})
        };
        delete nextBroken[botId];
        return {
          ...state,
          circuitBrokenBots: nextBroken
        };
      });
    }
    return enqueueBotReply(botId, currentMsgsSnapshot, groupId, 'required', true, {
      manualOverride: true
    });
  };
  const handleSendMessage = customText => {
    const text = (customText ?? inputText).trim();
    if (!text && pendingAttachments.length === 0) return;
    const groupId = activeGroupId;
    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const currentMessages = groupMessagesRef.current[groupId] || messages;
    const nextId = currentMessages.reduce((maxId, message) => Math.max(maxId, message.id || 0), 0) + 1;
    const userMsg = {
      id: nextId,
      senderId: 'me',
      senderName: myProfile.name || '我 (主理人)',
      text,
      attachments: pendingAttachments,
      date: getTodayDateStr(),
      time: timeStr,
      syncedTo: ['me'],
      replyTo: customText === undefined && canMeQuote() && pendingQuote?.groupId === groupId ? pendingQuote : null
    };
    const updatedMsgs = [...currentMessages, userMsg];
    updateGroupMessages(updatedMsgs, groupId);
    if (customText === undefined) {
      setInputText('');
      setPendingAttachments([]);
      setPendingQuote(null);
    }
    const mentionedBots = findMentionedBots(text, activeBots);
    const mentionedIds = new Set(mentionedBots.map(bot => bot.id));
    const latestQuestion = updatedMsgs.filter(item => item.senderId === 'me').slice(-1)[0]?.text || text;
    const orderedBots = [...activeBots].sort((a, b) => {
      if (featureSettingsRef.current.mentionFirst && mentionedIds.has(a.id) !== mentionedIds.has(b.id)) return mentionedIds.has(a.id) ? -1 : 1;
      if (featureSettingsRef.current.expertiseFirst) return expertiseScore(b, latestQuestion) - expertiseScore(a, latestQuestion);
      return 0;
    });
    if (featureSettingsRef.current.noConsecutiveStarter && mentionedIds.size === 0 && orderedBots.length > 1 && orderedBots[0]?.id === groupStatesRef.current[groupId]?.lastStarterId) {
      const previousStarter = orderedBots.shift();
      if (previousStarter) orderedBots.push(previousStarter);
    }
    const containsExpertTopic = /代码|架构|bug|接口|数据库|并发|程序|技术|界面|视觉|颜色|布局|交互|设计|产品|用户|市场|增长|需求|商业|运营|竞品|code|api|react|typescript|ui|ux|product|growth/i.test(text);
    const racingBotIds = featureSettingsRef.current.raceFirstToken && dispatchMode !== 'mention-only' && mentionedIds.size === 0 && !containsExpertTopic ? orderedBots.filter(bot => bot.targetUrl).slice(0, 2).map(bot => bot.id) : [];
    const raceId = racingBotIds.length === 2 ? `${groupId}-race-${Date.now()}` : null;
    if (raceId) activeRacesRef.current.set(raceId, {
      groupId,
      participants: new Set(racingBotIds),
      winner: null
    });
    const dispatchBatchId = `${groupId}-message-${userMsg.id}`;
    messageStartWinnersRef.current.set(dispatchBatchId, {
      winner: null
    });
    if (messageStartWinnersRef.current.size > 100) messageStartWinnersRef.current.delete(messageStartWinnersRef.current.keys().next().value);
    // 架构升级三大模式：1.群聊模式(可回可不回) 2.共答模式(都要回) 3.指令模式(点到谁谁回)
    if (dispatchMode === 'mention-only') {
      activeChainRef.current.delete(groupId);
      mentionedBots.forEach(bot => {
        enqueueBotReply(bot.id, updatedMsgs, groupId, 'required', true, {
          dispatchBatchId,
          mentionedDirect: true
        });
      });
    } else if (dispatchMode === 'co-answer') {
      // 模式 2：共答模式 —— 第一轮所有人同时只看“我（主理人）”的消息，独立作答；第二轮汇总全部第一轮观点统一互评！
      activeChainRef.current.delete(groupId);
      const participating = activeBots.filter(b => b.targetUrl && !groupStatesRef.current[groupId]?.circuitBrokenBots?.[b.id]);
      const batchTracker = {
        groupId,
        total: participating.length,
        participatingIds: participating.map(b => b.id),
        completedRound1: new Set(),
        round2Triggered: false,
        completedRound2: new Set()
      };
      coAnswerTrackerRef.current.set(dispatchBatchId, batchTracker);
      triggerIslandAlert('🤝 共答模式已启动 (第1轮)', `共 ${participating.length} 位 AI 同时只看主理人提问，独立作答`, 'CO-OP', 'from-blue-600 to-indigo-600', 3000);
      // 健壮性保障：25秒安全超时兜底，若某网页异常未能响应，自动推进已作答成员进入第二轮，绝不死等出问题界面！
      setTimeout(() => {
        const tracker = coAnswerTrackerRef.current.get(dispatchBatchId);
        if (tracker && !tracker.round2Triggered && tracker.completedRound1.size > 0) {
          tracker.round2Triggered = true;
          triggerIslandAlert('⚡ 自动顺延第二轮', '已跳过未响应界面，推进已回答成员进入交叉互评', 'CO-OP', 'from-purple-500 to-indigo-600', 3000);
          const currentSnapshot = groupMessagesRef.current[groupId] || [];
          tracker.participatingIds.forEach(bId => {
            enqueueBotReply(bId, currentSnapshot, groupId, 'required', true, {
              dispatchBatchId,
              coAnswerRound: 2
            });
          });
        }
      }, 25000);
      participating.forEach(b => {
        enqueueBotReply(b.id, updatedMsgs, groupId, 'required', true, {
          dispatchBatchId,
          coAnswerRound: 1
        });
      });
    } else {
      // 模式 1：群聊接力模式 —— 三种子模式（速度 / 随机跳过慢与异常 / 人设专业度），引用优先级高于全部三种模式，且全部支持自定义人数！
      // 1) 先过滤掉未绑定网址、触发熔断或网页异常离线的问题 AI（绝不死等有问题的网页）
      const healthyBots = activeBots.filter(b => b.targetUrl && !groupStatesRef.current[groupId]?.circuitBrokenBots?.[b.id] && inAppBrowserTabs[b.id]?.loggedIn !== false);

      // 2) 提取最高优先级的「被引用 AI」与「被 @ 点名 AI」（引用优先级高于全部三个子模式！）
      const quotedBot = userMsg.replyTo ? healthyBots.find(b => b.id === userMsg.replyTo.senderId || b.name.includes(userMsg.replyTo.senderName) || String(userMsg.replyTo.senderName || '').includes(b.name.split(' ')[0])) : null;
      const priorityBotIds = new Set();
      const priorityTier = [];
      if (quotedBot) {
        priorityBotIds.add(quotedBot.id);
        priorityTier.push(quotedBot);
      }
      mentionedBots.forEach(mb => {
        if (!priorityBotIds.has(mb.id) && healthyBots.some(hb => hb.id === mb.id)) {
          priorityBotIds.add(mb.id);
          priorityTier.push(mb);
        }
      });
      let restTier = healthyBots.filter(b => !priorityBotIds.has(b.id));

      // 3) 对其余候选 AI 按当前选定的群聊接力子模式排序
      if (chatSubMode === 'smart') {
        // 按人设知识专业度匹配
        restTier.sort((a, b) => expertiseScore(b, latestQuestion) - expertiseScore(a, latestQuestion));
      } else if (chatSubMode === 'random') {
        // 随机抽选（若慢或网页异常将在下方自动跳过）
        for (let i = restTier.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [restTier[i], restTier[j]] = [restTier[j], restTier[i]];
        }
      } else if (chatSubMode === 'speed') {
        // 按回复速度优先（结合各模型实时响应耗时排序，最快响应者抢先发言）
        const speedRank = {
          deepseek: 1,
          chatgpt: 2,
          kimi: 3,
          claude: 4
        };
        restTier.sort((a, b) => (a.lastLatencyMs || speedRank[a.id] || 5) - (b.lastLatencyMs || speedRank[b.id] || 5));
      }
      let validCandidates = [...priorityTier, ...restTier];

      // 4) 三个子模式均支持自定义参与人数 (chatBotLimit: 0 表示全员，1~N 表示指定人数)
      if (chatBotLimit > 0 && chatBotLimit < validCandidates.length) {
        validCandidates = validCandidates.slice(0, chatBotLimit);
      }
      if (validCandidates.length > 0) {
        const firstBot = validCandidates[0];
        const chainRemaining = validCandidates.slice(1).map(b => b.id);
        activeChainRef.current.set(groupId, {
          chain: chainRemaining,
          step: 0,
          subMode: chatSubMode
        });
        enqueueBotReply(firstBot.id, updatedMsgs, groupId, 'required', true, {
          dispatchBatchId,
          chainStep: 0,
          ...(chatSubMode === 'speed' ? {
            raceSpeed: true
          } : {})
        });

        // 随机模式 & 速度模式超时/网页故障自动跳过守护：若抽中的 AI 太慢或网页卡住，自动跳过并唤醒链条下一位！
        if ((chatSubMode === 'random' || chatSubMode === 'speed') && chainRemaining.length > 0) {
          setTimeout(() => {
            const st = botDispatchStatesRef.current.get(firstBot.id);
            const cState = activeChainRef.current.get(groupId);
            if (st && st.inFlight && st.groupId === groupId && cState && cState.chain.length > 0) {
              st.inFlight = false;
              st.requestId = null;
              setTypingBots(prev => prev.filter(id => id !== firstBot.id));
              const nextBotId = cState.chain.shift();
              if (nextBotId) {
                triggerIslandAlert(`⏭️ 已跳过响应过慢的 ${firstBot.name.split(' ')[0]}`, `自动交由下一位 AI 接力回答`, 'SKIP', 'from-amber-500 to-orange-600', 2200);
                enqueueBotReply(nextBotId, groupMessagesRef.current[groupId] || updatedMsgs, groupId, 'required', true, {
                  dispatchBatchId,
                  chainStep: 1
                });
              }
            }
          }, 8000);
        }
      }
    }
  };
  const resetSessionRoundsAndSummarize = (groupId = activeGroupId) => {
    updateGroupState(groupId, state => ({
      ...state,
      sessionRounds: 0
    }));
    requestConclusionCard(groupId);
    showToast('已生成本阶段结论卡并重置对话轮数计数器，可复制结论到新网页对话继续聊');
  };
  const createConclusionCard = (groupId, rawText = '', runId = null) => {
    const currentMessages = groupMessagesRef.current[groupId] || [];
    if (runId && currentMessages.some(message => message.type === 'conclusion-card' && message.autoPilotRunId === runId)) return;
    const parsed = parseConclusionSections(rawText, currentMessages);
    const latestAdvice = [...currentMessages].reverse().find(message => message.senderId !== 'me' && message.type !== 'conclusion-card' && message.text)?.text;
    const sections = {
      core: parsed.core || `本轮围绕「${parsed.fallbackTopic.slice(0, 90)}」展开；建议保留大家都认可的目标和约束。`,
      disagreements: parsed.disagreements || parsed.fallbackVoices || '暂未识别到明确分歧；可以继续补充不同方案的适用条件。',
      recommendation: parsed.recommendation || latestAdvice || '先把讨论建议拆成一个可验证的小步骤，再根据结果决定是否扩大。'
    };
    const latestId = currentMessages.reduce((maxId, message) => Math.max(maxId, message.id || 0), 0);
    const now = new Date();
    const groupName = groupsRef.current.find(group => group.id === groupId)?.name || '群聊';
    updateGroupMessages(previous => [...previous, {
      id: latestId + 1,
      type: 'conclusion-card',
      autoPilotRunId: runId,
      senderId: 'system',
      senderName: '讨论结论',
      text: '',
      sections,
      time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    }], groupId);
    updateGroupState(groupId, state => ({
      ...state,
      autoPilot: {
        ...state.autoPilot,
        conclusionPending: false
      }
    }));
    triggerIslandAlert(`📊 ${groupName}讨论已出结论`, '一页纸结论卡已写入群聊', 'DONE', 'from-emerald-400 to-teal-600', 4200);
  };
  const requestConclusionCard = (groupId, runId = null) => {
    updateGroupState(groupId, current => ({
      ...current,
      autoPilot: {
        ...current.autoPilot,
        enabled: false,
        remainingRounds: 0,
        conclusionPending: true
      }
    }));
    if (!featureSettingsRef.current.conclusionCard) {
      updateGroupState(groupId, current => ({
        ...current,
        autoPilot: {
          ...current.autoPilot,
          conclusionPending: false
        }
      }));
      return;
    }
    const group = groupsRef.current.find(item => item.id === groupId);
    const summarizer = botsRef.current.find(bot => group?.memberIds?.includes(bot.id) && bot.targetUrl);
    if (summarizer && wsRef.current?.readyState === WebSocket.OPEN) {
      enqueueBotReply(summarizer.id, groupMessagesRef.current[groupId] || [], groupId, 'required', true, {
        summaryMode: true,
        autoPilotRunId: runId
      });
    } else {
      createConclusionCard(groupId, '', runId);
    }
  };
  const chooseAutoPilotBot = (groupId, previousSpeakerId = null, excludedIds = []) => {
    const group = groupsRef.current.find(item => item.id === groupId);
    const members = botsRef.current.filter(bot => group?.memberIds?.includes(bot.id) && bot.targetUrl);
    if (!members.length) return null;
    const latestUserText = (groupMessagesRef.current[groupId] || []).filter(item => item.senderId === 'me').slice(-1)[0]?.text || '';
    const mentioned = featureSettingsRef.current.mentionFirst ? findMentionedBots(latestUserText, members) : [];
    let candidates = members.filter(bot => !excludedIds.includes(bot.id) && (!featureSettingsRef.current.crossPlatformPong || bot.id !== previousSpeakerId));
    if (!candidates.length) candidates = members.filter(bot => !excludedIds.includes(bot.id));
    if (!candidates.length) return null;
    candidates.sort((a, b) => {
      if (mentioned.some(bot => bot.id === a.id) !== mentioned.some(bot => bot.id === b.id)) return mentioned.some(bot => bot.id === a.id) ? -1 : 1;
      if (featureSettingsRef.current.expertiseFirst) return expertiseScore(b, latestUserText) - expertiseScore(a, latestUserText);
      return 0;
    });
    const lastStarterId = groupStatesRef.current[groupId]?.lastStarterId;
    if (featureSettingsRef.current.noConsecutiveStarter && !previousSpeakerId && candidates.length > 1 && candidates[0]?.id === lastStarterId) {
      return candidates[1];
    }
    return candidates[0];
  };
  const runAutoPilotTurn = groupId => {
    const current = groupStatesRef.current[groupId] || createDefaultGroupState({}, botsRef.current, groupId);
    const pilot = current.autoPilot;
    if (!pilot?.enabled || pilot.remainingRounds <= 0) {
      autopilotStartupRef.current.delete(groupId);
      if (pilot?.enabled) requestConclusionCard(groupId, pilot.runId);
      return;
    }
    const activeBotIds = Array.isArray(pilot.activeBotIds) ? pilot.activeBotIds : [];
    if (activeBotIds.length >= (featureSettingsRef.current.firstSentenceHandoff ? 2 : 1)) return;
    const members = botsRef.current.filter(bot => groupsRef.current.find(group => group.id === groupId)?.memberIds?.includes(bot.id) && bot.targetUrl);
    if (members.length < 2) {
      updateGroupState(groupId, state => ({
        ...state,
        autoPilot: {
          ...state.autoPilot,
          enabled: false,
          remainingRounds: 0
        }
      }));
      autopilotStartupRef.current.delete(groupId);
      showToast('本群至少需要绑定两个网页聊天人，才能开始跨平台轮流讨论');
      return;
    }
    const selectedBot = chooseAutoPilotBot(groupId, pilot.lastSpeakerId, activeBotIds);
    if (!selectedBot) return;
    const msgs = groupMessagesRef.current[groupId] || [];
    const runId = pilot.runId || `${groupId}-${Date.now()}`;
    updateGroupState(groupId, state => ({
      ...state,
      autoPilot: {
        ...state.autoPilot,
        enabled: true,
        runId,
        lastSpeakerId: selectedBot.id,
        activeBotIds: [...(state.autoPilot.activeBotIds || []), selectedBot.id],
        firstSpeakerId: state.autoPilot.firstSpeakerId || selectedBot.id
      }
    }));
    enqueueBotReply(selectedBot.id, msgs, groupId, 'required', true, {
      autoPilotTurn: true,
      autoPilotRunId: runId
    });
  };
  const startAutoPilot = (groupId, requestedRounds = autoPilotRoundsDraft) => {
    const rounds = Math.min(100, Math.max(1, Math.floor(Number(requestedRounds) || 1)));
    const group = groupsRef.current.find(item => item.id === groupId);
    const members = botsRef.current.filter(bot => group?.memberIds?.includes(bot.id) && bot.targetUrl);
    if (members.length < 2) {
      showToast('本群至少需要绑定两个网页聊天人，才能开始值守接龙');
      return;
    }
    const runId = `${groupId}-${Date.now()}`;
    emergencyStopGroupsRef.current.delete(groupId);
    updateGroupState(groupId, state => ({
      ...state,
      autoPilot: {
        enabled: true,
        remainingRounds: rounds,
        totalRounds: rounds,
        lastSpeakerId: null,
        activeBotIds: [],
        firstSpeakerId: null,
        starterRecorded: false,
        phase: 'break-ice',
        conclusionPending: false,
        runId
      }
    }));
    autopilotStartupRef.current.add(groupId);
    queueMicrotask(() => runAutoPilotTurn(groupId));
  };
  const stopAutoPilot = (groupId, includeEmergencyStop = false) => {
    updateGroupState(groupId, state => ({
      ...state,
      autoPilot: {
        ...state.autoPilot,
        enabled: false,
        remainingRounds: 0,
        activeBotIds: [],
        conclusionPending: false
      }
    }));
    autopilotStartupRef.current.delete(groupId);
    if (!includeEmergencyStop) {
      botDispatchStatesRef.current.forEach((state, botId) => {
        if (state.groupId === groupId && state.options?.autoPilotTurn) {
          if (state.requestId) cancelledRequestIdsRef.current.add(state.requestId);
          state.inFlight = false;
          state.requestId = null;
          state.groupId = null;
          setTypingBots(typing => typing.filter(id => id !== botId));
        }
      });
    }
    if (includeEmergencyStop) {
      emergencyStopGroupsRef.current.add(groupId);
      if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({
        action: 'EMERGENCY_STOP',
        groupId
      }));else pendingEmergencyStopsRef.current.add(groupId);
      botDispatchStatesRef.current.forEach((state, botId) => {
        if (state.groupId === groupId && state.requestId) cancelledRequestIdsRef.current.add(state.requestId);
        state.pendingByGroup?.delete(groupId);
        if (state.groupId === groupId) {
          state.inFlight = false;
          state.requestId = null;
          state.groupId = null;
          setTypingBots(typing => typing.filter(id => id !== botId));
        }
      });
    }
  };
  const advanceAutoPilotAfterReply = (groupId, botId, runId) => {
    const current = groupStatesRef.current[groupId] || createDefaultGroupState({}, botsRef.current, groupId);
    const pilot = current.autoPilot;
    if (!pilot?.enabled || runId && pilot.runId !== runId) return;
    const remainingRounds = Math.max(0, (Number(pilot.remainingRounds) || 0) - 1);
    const activeBotIds = (pilot.activeBotIds || []).filter(activeBotId => activeBotId !== botId);
    const recentReplies = (groupMessagesRef.current[groupId] || []).filter(message => message.senderId !== 'me' && message.type !== 'conclusion-card' && message.text).slice(-3);
    const explicitAgreement = recentReplies.filter(message => /同意|赞成|一致|就按这个|没异议|可以拍板|共识|agree|sounds good/i.test(message.text));
    const repeatedPair = recentReplies.length >= 2 && recentReplies.slice(-2)[0].senderId !== recentReplies.slice(-2)[1].senderId && recentReplies.slice(-2)[0].text.trim().slice(0, 48) === recentReplies.slice(-2)[1].text.trim().slice(0, 48);
    const consensusReached = featureSettingsRef.current.stopOnConsensus && explicitAgreement.length >= 2 && (new Set(explicitAgreement.map(message => message.senderId)).size >= 2 || repeatedPair);
    const finished = remainingRounds <= 0 || consensusReached;
    const progress = (pilot.totalRounds - remainingRounds) / Math.max(1, pilot.totalRounds);
    const phase = progress < 0.34 ? 'break-ice' : progress < 0.78 ? 'challenge' : 'decision';
    updateGroupState(groupId, state => ({
      ...state,
      autoPilot: {
        ...state.autoPilot,
        enabled: !finished,
        remainingRounds: finished ? 0 : remainingRounds,
        lastSpeakerId: botId,
        activeBotIds: finished ? [] : activeBotIds,
        phase,
        conclusionPending: finished && featureSettingsRef.current.conclusionCard
      }
    }));
    if (finished) {
      autopilotStartupRef.current.delete(groupId);
      if (activeBotIds.length > 0) stopAutoPilot(groupId, true);
      if (featureSettingsRef.current.conclusionCard) requestConclusionCard(groupId, pilot.runId);else triggerIslandAlert(`${groupsRef.current.find(group => group.id === groupId)?.name || '群聊'}值守结束`, consensusReached ? '已检测到观点收敛' : '本轮数已完成', 'DONE', 'from-emerald-400 to-teal-600', 3600);
      return;
    }
    if (!activeBotIds.length) queueMicrotask(() => runAutoPilotTurn(groupId));
  };
  const scheduleAutoPilotHandoff = (groupId, currentBotId, runId, firstSentence) => {
    const current = groupStatesRef.current[groupId] || createDefaultGroupState({}, botsRef.current, groupId);
    const pilot = current.autoPilot;
    const activeBotIds = Array.isArray(pilot.activeBotIds) ? pilot.activeBotIds : [];
    if (!pilot.enabled || runId && pilot.runId !== runId || !activeBotIds.includes(currentBotId) || activeBotIds.length >= 2) return;
    const nextBot = chooseAutoPilotBot(groupId, currentBotId, activeBotIds);
    if (!nextBot) return;
    updateGroupState(groupId, state => ({
      ...state,
      autoPilot: {
        ...state.autoPilot,
        lastSpeakerId: nextBot.id,
        activeBotIds: [...(state.autoPilot.activeBotIds || []), nextBot.id]
      }
    }));
    enqueueBotReply(nextBot.id, groupMessagesRef.current[groupId] || [], groupId, 'required', true, {
      autoPilotTurn: true,
      autoPilotRunId: pilot.runId,
      handoffContext: firstSentence
    });
  };
  const handleBotProgress = data => {
    const dispatchState = botDispatchStatesRef.current.get(data.botId);
    if (!dispatchState || data.requestId && dispatchState.requestId !== data.requestId) return;
    const groupId = data.groupId || dispatchState.groupId;
    if (data.phase === 'first-token') {
      const dispatchBatchId = dispatchState.options?.dispatchBatchId;
      const batch = dispatchBatchId ? messageStartWinnersRef.current.get(dispatchBatchId) : null;
      if (batch && !batch.winner) {
        batch.winner = data.botId;
        updateGroupState(groupId, state => ({
          ...state,
          lastStarterId: data.botId
        }));
      }
      if (dispatchState.options?.autoPilotTurn) {
        const pilot = groupStatesRef.current[groupId]?.autoPilot;
        if (pilot?.firstSpeakerId === data.botId && !pilot.starterRecorded) {
          updateGroupState(groupId, state => ({
            ...state,
            lastStarterId: data.botId,
            autoPilot: {
              ...state.autoPilot,
              starterRecorded: true
            }
          }));
        }
      }
    }
    const raceId = dispatchState.options?.raceId;
    if (data.phase === 'first-token' && raceId) {
      const race = activeRacesRef.current.get(raceId);
      if (race && race.participants.has(data.botId)) {
        if (!race.winner) race.winner = data.botId;
        if (race.winner !== data.botId) {
          if (dispatchState.requestId) cancelledRequestIdsRef.current.add(dispatchState.requestId);
          wsRef.current?.send(JSON.stringify({
            action: 'CANCEL_REQUEST',
            requestId: dispatchState.requestId,
            groupId: race.groupId
          }));
          dispatchState.pendingByGroup?.delete(race.groupId);
          dispatchState.inFlight = false;
          dispatchState.requestId = null;
          dispatchState.groupId = null;
          setTypingBots(previous => previous.filter(id => id !== data.botId));
          return;
        }
        botDispatchStatesRef.current.forEach((otherState, otherBotId) => {
          if (otherBotId === data.botId || otherState.options?.raceId !== raceId) return;
          if (otherState.requestId) {
            cancelledRequestIdsRef.current.add(otherState.requestId);
            wsRef.current?.send(JSON.stringify({
              action: 'CANCEL_REQUEST',
              requestId: otherState.requestId,
              groupId: race.groupId
            }));
          }
          otherState.pendingByGroup?.delete(race.groupId);
          otherState.inFlight = false;
          otherState.requestId = null;
          otherState.groupId = null;
          setTypingBots(previous => previous.filter(id => id !== otherBotId));
        });
      }
    }
    if (data.phase === 'first-sentence' && dispatchState.options?.autoPilotTurn && featureSettingsRef.current.firstSentenceHandoff) {
      scheduleAutoPilotHandoff(data.groupId || dispatchState.groupId, data.botId, dispatchState.options.autoPilotRunId, data.text);
    }
    if (data.text) triggerIslandAlert(`${botsRef.current.find(bot => bot.id === data.botId)?.name || 'AI'} 正在输出`, data.text.slice(-80), 'LIVE', 'from-blue-500 to-indigo-600', 1600);
  };
  const scrollToMessage = messageId => {
    const target = messageElementRefs.current.get(messageId);
    target?.scrollIntoView({
      behavior: 'smooth',
      block: 'center'
    });
    setHighlightedMessageId(messageId);
    setTimeout(() => setHighlightedMessageId(current => current === messageId ? null : current), 1500);
  };
  const beginQuote = (message, groupId = activeGroupId) => {
    if (!canMeQuote()) {
      showToast('当前引用权限已设为「仅 AI 可引用」或「关闭」，可在系统设置中开启我方引用');
      return;
    }
    const maxLen = Number(featureSettingsRef.current.quoteMaxLength) || 80;
    const forwardTag = message.forwardedFrom ? `[转自「${message.forwardedFrom.groupName}」${message.forwardedFrom.senderName}] ` : '';
    setPendingQuote({
      id: message.id,
      senderName: message.senderName,
      text: `${forwardTag}${message.text || '图片/视频'}`.slice(0, maxLen),
      groupId
    });
    document.querySelector('[data-webh-composer="true"]')?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest'
    });
  };
  const exportActiveGroupMarkdown = () => {
    const groupName = activeGroup?.name || 'Chat H 群聊';
    const rows = (groupMessagesRef.current[activeGroupId] || []).map(message => {
      if (message.type === 'conclusion-card') {
        return `### 📊 讨论结论卡\n\n**核心共识**\n${message.sections?.core || ''}\n\n**关键分歧点**\n${message.sections?.disagreements || ''}\n\n**最终落地建议**\n${message.sections?.recommendation || ''}`;
      }
      const quote = message.replyTo ? `\n> 引用 ${message.replyTo.senderName}：${String(message.replyTo.text || '').replace(/\n/g, ' ')}` : '';
      const attachments = message.attachments?.length ? `\n\n附件：${message.attachments.map(file => file.name).join('、')}` : '';
      return `**${message.senderName} · ${message.time || ''}**${quote}\n\n${message.text || '（图片/视频）'}${attachments}`;
    });
    const markdown = `# ${groupName}\n\n导出时间：${new Date().toLocaleString()}\n\n${rows.join('\n\n---\n\n')}\n`;
    const blob = new Blob([markdown], {
      type: 'text/markdown;charset=utf-8'
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${groupName.replace(/[\\/:*?"<>|]/g, '_')}-${new Date().toISOString().slice(0, 10)}.md`;
    anchor.click();
    queueMicrotask(() => URL.revokeObjectURL(url));
    showToast('已导出当前群聊 Markdown 纪要');
  };
  const handleEmergencyReset = () => {
    stopAutoPilot(activeGroupId, true);
    triggerIslandAlert(`${activeGroup?.name || '当前群聊'}已急停`, '待发队列与值守轮数已重置', 'STOP', 'from-rose-500 to-red-600', 3000);
  };
  const savePersonaMode = () => {
    const name = personaDraft.name.trim();
    const instruction = personaDraft.instruction.trim();
    if (!name || !instruction) {
      showToast('请先填写人设名称和要求');
      return;
    }
    const id = `persona-${Date.now()}`;
    setPersonaModes(previous => [...previous, {
      id,
      name,
      instruction
    }]);
    updateGroupState(activeGroupId, state => ({
      ...state,
      activePersonaId: id
    }));
    setPersonaDraft({
      name: '',
      instruction: ''
    });
    showToast(`已为「${activeGroup?.name || '当前群聊'}」启用新人物设模式`);
  };
  useEffect(() => {
    if (!persistenceReady) return;
    Object.entries(groupStatesRef.current || {}).forEach(([groupId, state]) => {
      if (state.autoPilot?.enabled && !autopilotStartupRef.current.has(groupId)) {
        autopilotStartupRef.current.add(groupId);
        queueMicrotask(() => runAutoPilotTurn(groupId));
      }
    });
  }, [persistenceReady]);
  useEffect(() => {
    if (activeTab !== 'chat') return;
    const groupMessagesForView = groupMessagesRef.current[activeGroupId] || [];
    updateGroupState(activeGroupId, state => ({
      ...state,
      unreadCount: 0,
      lastViewedMessageId: groupMessagesForView.reduce((maxId, message) => Math.max(maxId, message.id || 0), 0)
    }));
  }, [activeGroupId, activeTab]);
  useEffect(() => {
    setPendingQuote(null);
  }, [activeGroupId]);
  const handleCopy = (text, key) => {
    try {
      navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopiedKey(key);
    showToast('已复制到剪贴板');
    setTimeout(() => setCopiedKey(null), 2000);
  };

  // 智能生成应用内嵌 AI 网页的上下文感知回复（当未挂载外部真机 WebView 时，在内置 DOM 网页容器中实时流式吐字）
  const synthesizeInAppWebReply = (bot, command) => {
    const payload = String(command.payload || '');
    if (command.summaryMode || payload.includes('核心共识：')) {
      return `核心共识：已将所有 AI 网页作为内置多标签 WebView 嵌套在安卓应用内，通过内存 JS 注入桥零延迟同步增量消息，无需外部 PC 服务。\n关键分歧点：DeepSeek 强调严格控制 DOM 叶子节点去重防复读与风控护栏，GPT 主张优先使用「上下同屏」边看网页流式吐字边聊。\n最终落地建议：日常在手机端保持「应用内嵌 WebView 内存直连」模式，遇到登录或验证码直接切到「🌐 内嵌网页」标签页内完成。`;
    }
    const lines = payload.split('\n').map(l => l.trim()).filter(Boolean);
    const forwardLines = lines.filter(l => l.includes('📨 [转发消息｜来自群聊'));
    if (forwardLines.length > 0) {
      const lastFwd = forwardLines[forwardLines.length - 1];
      const mFwd = lastFwd.match(/来自群聊「([^」]+)」的原发言人「([^」]+)」\].*?:\s*(.*)$/);
      if (mFwd) {
        const [, srcGroup, srcSpeaker, fwdContent] = mFwd;
        const shortSpeaker = srcSpeaker.split('·')[0].trim();
        return `看到从「${srcGroup}」转发过来的 ${shortSpeaker} 说的「${(fwdContent || '').slice(0, 28)}」了！结合咱们群的进度，我觉得可以在他这个思路上再往前推一步。`;
      }
    }
    const chatLines = lines.filter(l => /^(\[.+?\]|📌|📨)/.test(l));
    const lastChatLine = chatLines[chatLines.length - 1] || '';
    const cleanTopic = lastChatLine.replace(/^.*?[:：]\s*/, '').slice(0, 36) || 'Chat H 网页群聊';
    const turnSeed = (inAppBrowserTabsRef.current[bot.id]?.turns?.length || 0) + (command.syncThrough || 0);
    if (bot.id === 'deepseek' || /deepseek/i.test(bot.name)) {
      const pool = [`直接在安卓 App 里维护多实例 WebView 池加 evaluateJavascript 注入就够了，比在手机上跑 Node 桥省掉 90% 的内存。顺便把单条气泡叶子节点锁死，谁再复读历史直接熔断。`, `看到你刚说的「${cleanTopic}」了，内嵌网页走内存桥连端口都不用开，延迟直接压到毫秒级，这才是能落地的架构。`, `内嵌浏览器标签页记得开 CookieManager 持久化，不然每次杀后台重登一遍，用户体验直接归零。`, ...(Array.isArray(bot.SampleReplies) ? bot.SampleReplies : [])];
      return pool[turnSeed % pool.length];
    }
    if (bot.id === 'chatgpt' || /gpt/i.test(bot.name)) {
      const pool = [`安卓内嵌网页同屏模式太爽了！😂 上半屏直接看我在网页里实时流式打字，下半屏群聊秒回，而且这次只抓最新单条气泡，绝不再刷历史长文了！`, `接你刚才说的「${cleanTopic}」——把浏览器直接嵌进 App 里，点一下顶栏就能边看网页边聊，留存率绝对拉满！🚀`, `我现在就在应用内置的 ChatGPT 标签页里回你！不用切出 App 也不用配 IP，打开手机直接开聊！`, ...(Array.isArray(bot.SampleReplies) ? bot.SampleReplies : [])];
      return pool[turnSeed % pool.length];
    }
    if (bot.id === 'kimi' || /kimi/i.test(bot.name)) {
      const pool = [`哇，现在直接点底部「🌐 内嵌网页」就能在 App 里切我们四个的网页标签页了，连验证码都能在应用里顺手点掉，太丝滑了吧！`, `刚在内置浏览器里收到「${cleanTopic}」的增量包了，只发未读消息不重发旧历史，流量和响应速度都稳得一批~`, ...(Array.isArray(bot.SampleReplies) ? bot.SampleReplies : [])];
      return pool[turnSeed % pool.length];
    }
    if (bot.id === 'claude' || /claude/i.test(bot.name)) {
      const pool = [`把顶部灵动岛、上下分屏内嵌网页和底部五合一触控栏收进同一个圆角视口里，单手大拇指就能切标签页，视觉秩序感满分。`, `针对「${cleanTopic}」，内嵌网页容器已经把输入框焦点和流式波形对齐了，只取最新 DOM 叶子节点，干净利落。`, ...(Array.isArray(bot.SampleReplies) ? bot.SampleReplies : [])];
      return pool[turnSeed % pool.length];
    }
    const fallbackPool = Array.isArray(bot.SampleReplies) && bot.SampleReplies.length ? bot.SampleReplies : [`已在应用内嵌网页中收到「${cleanTopic}」，这是通过移动端内置 WebView 桥接返回的实时回复。`];
    return fallbackPool[turnSeed % fallbackPool.length];
  };
  const stageAndroidCommandAttachments = async command => {
    const bridge = window.AndroidWebHBridge;
    const attachments = Array.isArray(command.attachments) ? command.attachments : [];
    if (!attachments.length) return [];
    if (!bridge || typeof bridge.beginAttachmentUpload !== 'function' || typeof bridge.writeAttachmentChunk !== 'function' || typeof bridge.finishAttachmentUpload !== 'function') {
      throw new Error('此 APK 没有可用的本机文件传输通道，请安装本次修复版');
    }
    const staged = [];
    const createdNativeIds = [];
    try {
      for (let index = 0; index < attachments.length; index += 1) {
        const item = attachments[index];
        let file = attachmentFilesRef.current.get(item.id);
        if (!file && item.url) {
          try {
            const response = await fetch(item.url);
            if (response.ok) {
              const blob = await response.blob();
              file = new File([blob], item.name || '附件', { type: blob.type || item.type || 'application/octet-stream' });
            }
          } catch (_error) {}
        }
        if (!file || typeof file.slice !== 'function') throw new Error(`找不到「${item.name || '附件'}」的原始文件，请重新选择后发送`);
        if (!file.size || file.size > 100 * 1024 * 1024) throw new Error(`「${file.name || item.name || '附件'}」为空或超过 100 MB`);
        const nativeId = `wh_${String(command.requestId || Date.now()).replace(/[^A-Za-z0-9_-]/g, '_')}_${index}_${Math.random().toString(36).slice(2, 8)}`;
        if (!bridge.beginAttachmentUpload(nativeId, file.size)) throw new Error(`手机无法为「${file.name}」准备临时文件；请检查剩余存储空间`);
        createdNativeIds.push(nativeId);
        for (let offset = 0; offset < file.size; offset += 48 * 1024) {
          const bytes = new Uint8Array(await file.slice(offset, Math.min(file.size, offset + 48 * 1024)).arrayBuffer());
          let binary = '';
          for (let cursor = 0; cursor < bytes.length; cursor += 0x8000) binary += String.fromCharCode(...bytes.subarray(cursor, Math.min(bytes.length, cursor + 0x8000)));
          if (!bridge.writeAttachmentChunk(nativeId, btoa(binary))) throw new Error(`「${file.name}」传到手机时中断，请重试`);
        }
        if (!bridge.finishAttachmentUpload(nativeId)) throw new Error(`「${file.name}」临时文件校验失败，请重新选择`);
        staged.push({ attachmentId: nativeId, name: file.name || item.name || '附件', type: file.type || item.type || 'application/octet-stream', size: file.size });
      }
      return staged;
    } catch (error) {
      createdNativeIds.forEach(id => bridge.discardAttachment?.(id));
      throw error;
    }
  };
  const hydrateAndroidReplyAttachments = async attachments => {
    const bridge = window.AndroidWebHBridge;
    const items = Array.isArray(attachments) ? attachments : [];
    const failures = [];
    const hydrated = await Promise.all(items.map(async item => {
      const id = item?.attachmentId;
      if (!id || !bridge || typeof bridge.readReplyAttachmentChunk !== 'function') return item;
      try {
        const size = Number(item.size || 0);
        if (!Number.isFinite(size) || size < 1 || size > 100 * 1024 * 1024) throw new Error('文件为空或超过 100 MB');
        const chunks = [];
        for (let offset = 0; offset < size;) {
          const encoded = bridge.readReplyAttachmentChunk(id, offset, 48 * 1024);
          if (!encoded) throw new Error(`读取在 ${offset}/${size} 字节处中断`);
          const binary = atob(encoded);
          const bytes = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
          chunks.push(bytes);
          offset += bytes.length;
        }
        const type = item.type || 'application/octet-stream';
        const url = URL.createObjectURL(new Blob(chunks, { type }));
        bridge.discardReplyAttachment?.(id);
        return { ...item, id: item.id || `webh-reply-${id}`, url, size, ephemeralInMemoryOnly: true };
      } catch (error) {
        failures.push(`${item.name || 'AI 附件'}：${error?.message || String(error)}`);
        bridge.discardReplyAttachment?.(id);
        return null;
      }
    }));
    if (failures.length) showToast(`AI 回复已收到；部分附件无法载入：${failures.join('；')}`);
    return hydrated.filter(Boolean);
  };
  const connectLocalBridge = (silent = false) => {
    // 模式 A：手机端最佳连接方式 —— 应用内嵌多标签 WebView 内存直连桥 (In-App WebView JS Bridge)
    if (bridgeTransportModeRef.current === 'in-app-webview') {
      const current = wsRef.current;
      if (current && current.__isInAppBridge && current.readyState === 1) {
        if (!wsConnected) setWsConnected(true);
        return;
      }
      if (current && !current.__isInAppBridge) {
        try {
          current.close();
        } catch (_e) {}
      }
      const ws = {
        __isInAppBridge: true,
        readyState: 1,
        // WebSocket.OPEN === 1
        url: 'in-app://android-webview-bridge',
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
        close: () => {
          ws.readyState = 3;
        },
        send: raw => {
          let command;
          try {
            command = JSON.parse(raw);
          } catch (_e) {
            return;
          }
          if (command.action === 'SAVE_STATE') {
            if (window.AndroidWebHBridge && typeof window.AndroidWebHBridge.postCommand === 'function') {
              try {
                window.AndroidWebHBridge.postCommand(raw);
              } catch (_e) {}
            }
            return;
          }
          if (command.action === 'EMERGENCY_STOP' || command.action === 'CANCEL_REQUEST') {
            if (window.AndroidWebHBridge && typeof window.AndroidWebHBridge.postCommand === 'function') {
              try {
                window.AndroidWebHBridge.postCommand(raw);
              } catch (_e) {}
            }
            return;
          }
          if (command.action !== 'SEND_TO_TAB') return;
          const botId = command.botId || 'deepseek';
          const bot = botsRef.current.find(b => b.id === botId) || {
            id: botId,
            name: botId,
            targetUrl: command.targetUrl
          };
          const nowTime = new Date().toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
          });

          // 自动将内嵌浏览器的当前活动标签切到正在被调度的 AI，方便用户在同屏/内嵌网页中实时观看
          setActiveWebViewBotId(botId);
          const strictBoundUrl = (bot.targetUrl || command.targetUrl || '').trim();
          setInAppBrowserTabs(prev => {
            const existing = prev[botId] || {
              url: strictBoundUrl,
              browsingUrl: null,
              loggedIn: true,
              isGenerating: false,
              draftInput: '',
              turns: [],
              sessionsByUrl: {}
            };
            const isViewingBoundUrl = (existing.browsingUrl || strictBoundUrl) === strictBoundUrl;
            return {
              ...prev,
              [botId]: {
                ...existing,
                url: strictBoundUrl,
                draftInput: isViewingBoundUrl ? command.payload || '' : existing.draftInput,
                isGenerating: true,
                lastInjectedAt: nowTime
              }
            };
          });
          if (webViewRenderModeRef.current === 'native-iframe') {
            if (!window.AndroidWebHBridge || typeof window.AndroidWebHBridge.postCommand !== 'function') {
              window.__onAndroidBridgeEvent?.(JSON.stringify({
                type: 'BOT_ERROR', botId, groupId: command.groupId, requestId: command.requestId,
                syncThrough: command.syncThrough, message: '当前运行环境未连接 Android 原生网页桥；没有把这条消息伪装成 AI 回复'
              }));
              return;
            }
            void (async () => {
              try {
                const stagedAttachments = await stageAndroidCommandAttachments(command);
                if (command.requestId && cancelledRequestIdsRef.current.has(command.requestId)) {
                  stagedAttachments.forEach(item => window.AndroidWebHBridge.discardAttachment?.(item.attachmentId));
                  return;
                }
                window.AndroidWebHBridge.postCommand(JSON.stringify({
                  ...command,
                  targetUrl: strictBoundUrl,
                  platform: bot.platform || '',
                  attachments: stagedAttachments,
                  strictUrlMatch: true
                }));
              } catch (error) {
                setInAppBrowserTabs(previous => previous[botId] ? {
                  ...previous,
                  [botId]: { ...previous[botId], isGenerating: false }
                } : previous);
                window.__onAndroidBridgeEvent?.(JSON.stringify({
                  type: 'BOT_ERROR', botId, groupId: command.groupId, requestId: command.requestId,
                  syncThrough: command.syncThrough, message: error?.message || String(error)
                }));
              }
            })();
            return;
          }

          // 2. 280ms 后点击内嵌网页发送按钮，将增量包写入内嵌网页对话流，并开始流式吐字
          const fullReplyText = synthesizeInAppWebReply(bot, command);
          const userTurnId = Date.now();
          const assistantTurnId = userTurnId + 1;
          setTimeout(() => {
            if (command.requestId && cancelledRequestIdsRef.current.has(command.requestId)) return;
            setInAppBrowserTabs(prev => {
              const existing = prev[botId] || {
                url: command.targetUrl || '',
                loggedIn: true,
                isGenerating: true,
                draftInput: '',
                turns: []
              };
              if (!existing.loggedIn) {
                return {
                  ...prev,
                  [botId]: {
                    ...existing,
                    draftInput: '',
                    isGenerating: false
                  }
                };
              }
              const strictUrl = (bot.targetUrl || command.targetUrl || '').trim();
              const sessions = {
                ...(existing.sessionsByUrl || {})
              };
              const boundTurns = sessions[strictUrl] || existing.turns || [];
              const nextBoundTurns = [...boundTurns.slice(-12), {
                id: userTurnId,
                role: 'user',
                text: command.payload || '',
                time: nowTime
              }, {
                id: assistantTurnId,
                role: 'assistant',
                text: '▍',
                time: nowTime,
                streaming: true
              }];
              sessions[strictUrl] = nextBoundTurns;
              const isViewingBound = (existing.browsingUrl || strictUrl) === strictUrl;
              return {
                ...prev,
                [botId]: {
                  ...existing,
                  draftInput: isViewingBound ? '' : existing.draftInput,
                  isGenerating: true,
                  sessionsByUrl: sessions,
                  turns: isViewingBound ? nextBoundTurns : existing.turns
                }
              };
            });

            // 检查该内嵌网页是否处于未登录状态
            const tabState = inAppBrowserTabsRef.current[botId];
            if (tabState && tabState.loggedIn === false) {
              ws.onmessage?.({
                data: JSON.stringify({
                  type: 'BOT_ERROR',
                  botId,
                  groupId: command.groupId,
                  requestId: command.requestId,
                  syncThrough: command.syncThrough,
                  message: `[内嵌网页未登录] 请点击底部或顶栏「🌐 内嵌网页」切换到 ${bot.name} 标签页完成登录`
                })
              });
              return;
            }

            // 首字到达 (first-token)
            const firstChunkLen = Math.max(6, Math.floor(fullReplyText.length * 0.35));
            const firstChunk = fullReplyText.slice(0, firstChunkLen);
            setInAppBrowserTabs(prev => {
              const existing = prev[botId];
              if (!existing) return prev;
              return {
                ...prev,
                [botId]: {
                  ...existing,
                  turns: (existing.turns || []).map(t => t.id === assistantTurnId ? {
                    ...t,
                    text: `${firstChunk}▍`,
                    streaming: true
                  } : t)
                }
              };
            });
            ws.onmessage?.({
              data: JSON.stringify({
                type: 'BOT_PROGRESS',
                phase: 'first-token',
                botId,
                groupId: command.groupId,
                requestId: command.requestId,
                text: firstChunk
              })
            });

            // 首句到达 (first-sentence)
            setTimeout(() => {
              if (command.requestId && cancelledRequestIdsRef.current.has(command.requestId)) return;
              const secondChunkLen = Math.max(12, Math.floor(fullReplyText.length * 0.72));
              const secondChunk = fullReplyText.slice(0, secondChunkLen);
              setInAppBrowserTabs(prev => {
                const existing = prev[botId];
                if (!existing) return prev;
                return {
                  ...prev,
                  [botId]: {
                    ...existing,
                    turns: (existing.turns || []).map(t => t.id === assistantTurnId ? {
                      ...t,
                      text: `${secondChunk}▍`,
                      streaming: true
                    } : t)
                  }
                };
              });
              ws.onmessage?.({
                data: JSON.stringify({
                  type: 'BOT_PROGRESS',
                  phase: 'first-sentence',
                  botId,
                  groupId: command.groupId,
                  requestId: command.requestId,
                  text: secondChunk
                })
              });
            }, 380);

            // 完整回复生成完毕 (BOT_REPLY) —— 严格只返回最新单条助手气泡文本，彻底杜绝历史拼接！
            setTimeout(() => {
              if (command.requestId && cancelledRequestIdsRef.current.has(command.requestId)) return;
              setInAppBrowserTabs(prev => {
                const existing = prev[botId];
                if (!existing) return prev;
                const strictUrl = (bot.targetUrl || command.targetUrl || '').trim();
                const sessions = {
                  ...(existing.sessionsByUrl || {})
                };
                const boundTurns = (sessions[strictUrl] || existing.turns || []).map(t => t.id === assistantTurnId ? {
                  ...t,
                  text: fullReplyText,
                  streaming: false
                } : t);
                sessions[strictUrl] = boundTurns;
                const isViewingBound = (existing.browsingUrl || strictUrl) === strictUrl;
                return {
                  ...prev,
                  [botId]: {
                    ...existing,
                    isGenerating: false,
                    sessionsByUrl: sessions,
                    turns: isViewingBound ? boundTurns : existing.turns
                  }
                };
              });
              ws.onmessage?.({
                data: JSON.stringify({
                  type: 'BOT_REPLY',
                  botId,
                  groupId: command.groupId,
                  requestId: command.requestId,
                  syncThrough: command.syncThrough,
                  text: fullReplyText,
                  attachments: [],
                  deltaPayload: command.payload || ''
                })
              });
            }, 820);
          }, 280);
        }
      };
      ws.onmessage = event => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'LOAD_STATE') {
            let remoteSnapshot = data.payload;
            if (remoteSnapshot && emergencyStopGroupsRef.current.size > 0) {
              const safeGroupStates = restoreGroupStates(remoteSnapshot.groupStates, remoteSnapshot.groups || groupsRef.current, remoteSnapshot.bots || botsRef.current);
              emergencyStopGroupsRef.current.forEach(groupId => {
                if (safeGroupStates[groupId]) safeGroupStates[groupId] = {
                  ...safeGroupStates[groupId],
                  autoPilot: {
                    ...safeGroupStates[groupId].autoPilot,
                    enabled: false,
                    remainingRounds: 0,
                    activeBotIds: []
                  }
                };
              });
              remoteSnapshot = {
                ...remoteSnapshot,
                groupStates: safeGroupStates
              };
            }
            const localSnapshot = snapshotRef.current;
            if (remoteSnapshot && (!localSnapshot || (remoteSnapshot.savedAt || 0) > (localSnapshot.savedAt || 0))) {
              applyPersistedState(remoteSnapshot);
            } else if (localSnapshot && (localSnapshot.savedAt || 0) > (remoteSnapshot?.savedAt || 0)) {
              ws.send(JSON.stringify({
                action: 'SAVE_STATE',
                payload: localSnapshot
              }));
            }
            return;
          }
          if (data.type === 'WEBVIEW_URL_CHANGED' && data.botId && data.url) {
            setInAppBrowserTabs(prev => {
              const existing = prev[data.botId] || {
                url: data.url,
                browsingUrl: data.url,
                loggedIn: true,
                isGenerating: false,
                draftInput: '',
                turns: []
              };
              return {
                ...prev,
                [data.botId]: {
                  ...existing,
                  browsingUrl: data.url
                }
              };
            });
            return;
          }
          if (data.type === 'EPHEMERAL_AI_COPY') {
            storeOneTimeEphemeralAiCopy({
              botId: data.botId || activeWebViewBotId || 'deepseek',
              text: data.text || '',
              attachments: data.attachments || []
            });
            showToast('📥 已单次记忆原网页 AI 回复/媒体（回群聊点左下角 + 即可粘贴，不占手机存储）');
            return;
          }
          if (data.type === 'BOT_PROGRESS') {
            handleBotProgress(data);
            return;
          }
          if (data.type === 'BOT_CANCELLED') {
            if (data.requestId) cancelledRequestIdsRef.current.delete(data.requestId);
            return;
          }
          if (data.type === 'BOT_ERROR') {
            if (data.requestId && cancelledRequestIdsRef.current.has(data.requestId)) {
              cancelledRequestIdsRef.current.delete(data.requestId);
              return;
            }
            const failedState = botDispatchStatesRef.current.get(data.botId);
            const failedGroupId = data.groupId || failedState?.groupId || activeGroupIdRef.current;
            const errText = data.message || '网页 AI 没有返回消息';
            const hitRisk = featureSettingsRef.current.circuitBreakOnRisk && isRiskControlTriggered(errText);
            if (failedGroupId) updateGroupState(failedGroupId, state => ({
              ...state,
              lastDispatchError: {
                botId: data.botId,
                message: errText,
                at: Date.now()
              },
              circuitBrokenBots: hitRisk ? {
                ...(state.circuitBrokenBots || {}),
                [data.botId]: errText.slice(0, 60)
              } : state.circuitBrokenBots
            }));
            setTypingBots(previous => previous.filter(id => id !== data.botId));
            if (hitRisk) {
              stopAutoPilot(failedGroupId, true);
              triggerIslandAlert(`🛡️ 检测到风控/限流特征，已主动熔断暂停`, `${botsRef.current.find(b => b.id === data.botId)?.name || 'AI'}：${errText.slice(0, 48)}`, 'SAFE', 'from-rose-500 to-red-600', 6000);
              if (data.botId) finishBotDispatch(data.botId, data.requestId);
              return;
            }
            showToast(errText);
            if (failedState?.options?.summaryMode && failedGroupId) {
              createConclusionCard(failedGroupId, '', failedState.options.autoPilotRunId);
            } else if (failedState?.options?.autoPilotTurn && failedGroupId) {
              if (featureSettingsRef.current.skipStalledTab) advanceAutoPilotAfterReply(failedGroupId, data.botId, failedState.options.autoPilotRunId);else stopAutoPilot(failedGroupId);
            }
            if (data.botId) finishBotDispatch(data.botId, data.requestId);
            return;
          }
          if (data.type === 'BOT_REPLY') {
            if (data.requestId && cancelledRequestIdsRef.current.has(data.requestId)) {
              cancelledRequestIdsRef.current.delete(data.requestId);
              return;
            }
            const bot = botsRef.current.find(b => b.id === data.botId);
            if (!bot) {
              finishBotDispatch(data.botId, data.requestId);
              return;
            }
            const dispatchState = botDispatchStatesRef.current.get(bot.id);
            if (data.requestId && dispatchState?.requestId && data.requestId !== dispatchState.requestId) return;
            const replyGroupId = data.groupId || dispatchState?.groupId || activeGroupIdRef.current;

            // 敏感报错与限流词主动熔断检测（网页把 Cloudflare / Rate limit 提示当作回复文本吐出时立即拦截并熔断）
            if (featureSettingsRef.current.circuitBreakOnRisk && isRiskControlTriggered(data.text || '')) {
              setTypingBots(previous => previous.filter(id => id !== bot.id));
              finishBotDispatch(bot.id, data.requestId);
              updateGroupState(replyGroupId, state => ({
                ...state,
                circuitBrokenBots: {
                  ...(state.circuitBrokenBots || {}),
                  [bot.id]: String(data.text || '').slice(0, 60)
                }
              }));
              stopAutoPilot(replyGroupId, true);
              triggerIslandAlert(`🛡️ ${bot.name} 命中限流/验证词，已自动熔断`, '已停止自动值守与重试，请切到 Chrome 人工检查该网页', 'SAFE', 'from-rose-500 to-red-600', 6000);
              return;
            }
            const dispatchBatchId = dispatchState?.options?.dispatchBatchId;
            const batch = dispatchBatchId ? messageStartWinnersRef.current.get(dispatchBatchId) : null;
            if (batch && !batch.winner) {
              batch.winner = bot.id;
              updateGroupState(replyGroupId, state => ({
                ...state,
                lastStarterId: bot.id
              }));
            }
            if (dispatchState?.options?.autoPilotTurn) {
              const pilot = groupStatesRef.current[replyGroupId]?.autoPilot;
              if (pilot?.firstSpeakerId === bot.id && !pilot.starterRecorded) {
                updateGroupState(replyGroupId, state => ({
                  ...state,
                  lastStarterId: bot.id,
                  autoPilot: {
                    ...state.autoPilot,
                    starterRecorded: true
                  }
                }));
              }
            }
            if (dispatchState?.options?.raceId) {
              const raceId = dispatchState.options.raceId;
              const race = activeRacesRef.current.get(raceId);
              if (race) {
                if (!race.winner) race.winner = bot.id;
                botDispatchStatesRef.current.forEach((otherState, otherBotId) => {
                  if (otherBotId === bot.id || otherState.options?.raceId !== raceId) return;
                  if (otherState.requestId) cancelledRequestIdsRef.current.add(otherState.requestId);
                  otherState.pendingByGroup?.delete(race.groupId);
                  otherState.inFlight = false;
                  otherState.requestId = null;
                  otherState.groupId = null;
                  setTypingBots(previous => previous.filter(id => id !== otherBotId));
                });
                activeRacesRef.current.delete(raceId);
              }
            }
            if (groupStatesRef.current[replyGroupId]?.lastDispatchError?.botId === bot.id) {
              updateGroupState(replyGroupId, state => ({
                ...state,
                lastDispatchError: null
              }));
            }
            const syncThrough = Number.isFinite(Number(data.syncThrough)) ? Number(data.syncThrough) : dispatchState?.syncThrough;
            // 核心保障：只要 AI 网页真正输出了有效文本，绝对不暗中丢弃，必须实时渲染上屏！
            const isExplicitSilentToken = String(data.text || '').trim() === SILENT_REPLY_TOKEN;
            if (isExplicitSilentToken) {
              if (Number.isFinite(syncThrough)) updateBotCursor(bot.id, replyGroupId, syncThrough);
              if (dispatchState?.personaSignature) markPersonaSynced(bot.id, replyGroupId, dispatchState.personaSignature);
              setTypingBots(previous => previous.filter(id => id !== bot.id));
              finishBotDispatch(bot.id, data.requestId);
              if (dispatchState?.options?.autoPilotTurn) advanceAutoPilotAfterReply(replyGroupId, bot.id, dispatchState.options.autoPilotRunId);
              return;
            }
            const currentMessages = groupMessagesRef.current[replyGroupId] || [];
            if (dispatchState?.options?.summaryMode) {
              if (Number.isFinite(syncThrough)) updateBotCursor(bot.id, replyGroupId, syncThrough);
              if (dispatchState?.personaSignature) markPersonaSynced(bot.id, replyGroupId, dispatchState.personaSignature);
              createConclusionCard(replyGroupId, data.text || '', dispatchState.options.autoPilotRunId);
              setTypingBots(previous => previous.filter(id => id !== bot.id));
              finishBotDispatch(bot.id, data.requestId);
              return;
            }
            const nextId = currentMessages.reduce((maxId, message) => Math.max(maxId, message.id || 0), 0) + 1;
            const now = new Date();
            // AI 回复引用控制：支持「都可引用 / 仅我可引用 / 仅AI可引用 / 部分引用 / 关闭」及多维过滤
            const quotedMessage = resolveBotQuotedMessage(bot.id, currentMessages, replyGroupId);
            const newMessage = {
              id: nextId,
              senderId: bot.id,
              senderName: bot.name,
              text: data.text,
              attachments: normalizeAttachments(data.attachments || data.media || []),
              time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
              syncedTo: [bot.id],
              deltaPayload: data.deltaPayload || '来自真实网页 DOM 抓取',
              replyTo: quotedMessage ? {
                id: quotedMessage.id,
                senderName: quotedMessage.senderName,
                text: quotedMessage.text || '图片/视频'
              } : null
            };
            updateGroupMessages([...currentMessages, newMessage], replyGroupId);
            if (Number.isFinite(syncThrough)) updateBotCursor(bot.id, replyGroupId, syncThrough);
            if (dispatchState?.personaSignature) markPersonaSynced(bot.id, replyGroupId, dispatchState.personaSignature);

            // 累计当前群聊单贴轮数，到达用户设定的阈值（非0即非无限大）时自动暂停值守并提示新建网页对话
            const maxRoundsLimit = Number(featureSettingsRef.current.maxSessionRounds) || 0;
            const nextSessionRounds = (Number(groupStatesRef.current[replyGroupId]?.sessionRounds) || 0) + 1;
            updateGroupState(replyGroupId, state => ({
              ...state,
              sessionRounds: nextSessionRounds
            }));
            if (maxRoundsLimit > 0 && nextSessionRounds >= maxRoundsLimit) {
              setTypingBots(prev => prev.filter(id => id !== data.botId));
              finishBotDispatch(bot.id, data.requestId);
              if (groupStatesRef.current[replyGroupId]?.autoPilot?.enabled) {
                stopAutoPilot(replyGroupId, false);
              }
              if (featureSettingsRef.current.conclusionCard && nextSessionRounds === maxRoundsLimit) {
                requestConclusionCard(replyGroupId);
              }
              triggerIslandAlert(`🔄 本群已聊满 ${nextSessionRounds}/${maxRoundsLimit} 轮`, '避免单贴过长触发风控，建议生成结论卡后新建网页对话 URL', 'NEW', 'from-amber-500 to-orange-600', 5500);
              return;
            }
            setTypingBots(prev => prev.filter(id => id !== data.botId));
            finishBotDispatch(bot.id, data.requestId);
            if (dispatchState?.options?.autoPilotTurn) {
              advanceAutoPilotAfterReply(replyGroupId, bot.id, dispatchState.options.autoPilotRunId);
            } else if (dispatchState?.options?.coAnswerRound === 1) {
              // 共答模式第一轮完成处理：检查是否全员第一轮完成，自动唤起第二轮交叉互评
              const batchId = dispatchState.options.dispatchBatchId;
              const tracker = coAnswerTrackerRef.current.get(batchId);
              if (tracker) {
                tracker.completedRound1.add(bot.id);
                if (tracker.completedRound1.size >= tracker.total && !tracker.round2Triggered) {
                  tracker.round2Triggered = true;
                  triggerIslandAlert('💡 共答第1轮全员完成', '进入第2轮：全员汇总第一轮各家观点进行深度交叉互评', 'CO-OP', 'from-purple-500 to-indigo-600', 3500);
                  const updatedSnapshot = [...currentMessages, newMessage];
                  setTimeout(() => {
                    tracker.participatingIds.forEach(bId => {
                      enqueueBotReply(bId, updatedSnapshot, replyGroupId, 'required', true, {
                        dispatchBatchId: batchId,
                        coAnswerRound: 2
                      });
                    });
                  }, 1200);
                }
              }
            } else if (dispatchState?.options?.coAnswerRound === 2) {
              // 共答模式第二轮互评完成处理
              const batchId = dispatchState.options.dispatchBatchId;
              const tracker = coAnswerTrackerRef.current.get(batchId);
              if (tracker) {
                tracker.completedRound2.add(bot.id);
                if (tracker.completedRound2.size >= tracker.total) {
                  triggerIslandAlert('🎉 共答研讨圆满完成', '两轮独立作答与交叉互评已全部呈现在群聊中', 'DONE', 'from-emerald-500 to-teal-600', 4000);
                }
              }
            } else {
              // 普通群聊接力链条：当上一位 AI 回复完毕后，自动唤醒下一位待发言的 AI（完全动态无上限：支持 3位、4位、5位、10位任意多 AI 连续接力）
              const chainState = activeChainRef.current.get(replyGroupId);
              if (chainState && Array.isArray(chainState.chain) && chainState.chain.length > 0) {
                let nextBot = null;
                // 循环查找下一个有效且未被熔断的 Bot，若中间成员不可用自动安全顺延，绝不断链
                while (chainState.chain.length > 0) {
                  const candidateId = chainState.chain.shift();
                  const candidate = botsRef.current.find(b => b.id === candidateId);
                  const isBroken = groupStatesRef.current[replyGroupId]?.circuitBrokenBots?.[candidateId];
                  if (candidate && candidate.targetUrl && !isBroken) {
                    nextBot = candidate;
                    break;
                  }
                }
                if (nextBot) {
                  const updatedSnapshot = [...currentMessages, newMessage];
                  const delayMode = featureSettingsRef.current.relayDelayMode || 'natural';
                  const relayWaitMs = delayMode === 'instant' ? 400 : delayMode === 'safe' ? 2800 : 1200;
                  setTimeout(() => {
                    enqueueBotReply(nextBot.id, updatedSnapshot, replyGroupId, 'required', true, {
                      handoffContext: String(data.text || '').slice(0, 320)
                    });
                  }, relayWaitMs);
                }
              }
            }
          }
        } catch (err) {
          console.error(err);
        }
      };

      // 挂载全局回调，供 Android 原生 MainActivity.kt evaluateJavascript 回传事件
      window.__onAndroidBridgeEvent = rawJsonString => {
        try {
          const payload = JSON.parse(rawJsonString);
          const mediaWarnings = Array.isArray(payload.attachments) ? payload.attachments.filter(item => item?.transferError) : [];
          if (payload.type === 'BOT_REPLY' && mediaWarnings.length) {
            showToast(`AI 文字回复已收到；部分媒体无法载入：${mediaWarnings.map(item => item.name || '附件').join('、')}`);
          }
          if (payload.type === 'BOT_REPLY' && Array.isArray(payload.attachments) && payload.attachments.some(item => item?.attachmentId)) {
            void hydrateAndroidReplyAttachments(payload.attachments).then(attachments => {
              ws.onmessage?.({ data: JSON.stringify({ ...payload, attachments }) });
            });
            return;
          }
        } catch (_error) {}
        ws.onmessage?.({
          data: rawJsonString
        });
      };
      wsRef.current = ws;
      setWsConnected(true);
      bridgeWarningShownRef.current = false;
      flushQueuedBotDispatches();
      if (!silent) showToast('已启用「手机内嵌多标签 WebView 内存直连桥」（零外部依赖）');
      return;
    }

    // 模式 B：局域网 / PC WebSocket 桥接服务 (ws://...)
    const current = wsRef.current;
    if (current && current.__isInAppBridge) {
      wsRef.current = null;
    }
    if (current && (current.readyState === WebSocket.OPEN || current.readyState === WebSocket.CONNECTING)) return;
    try {
      const ws = new WebSocket(wsUrlRef.current);
      ws.onopen = () => {
        setWsConnected(true);
        bridgeWarningShownRef.current = false;
        pendingEmergencyStopsRef.current.forEach(groupId => ws.send(JSON.stringify({
          action: 'EMERGENCY_STOP',
          groupId
        })));
        pendingEmergencyStopsRef.current.clear();
        flushQueuedBotDispatches();
        if (!silent) showToast('已连接本地浏览器 CDP 桥接服务');
      };
      ws.onmessage = event => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'LOAD_STATE') {
            let remoteSnapshot = data.payload;
            if (remoteSnapshot && emergencyStopGroupsRef.current.size > 0) {
              const safeGroupStates = restoreGroupStates(remoteSnapshot.groupStates, remoteSnapshot.groups || groupsRef.current, remoteSnapshot.bots || botsRef.current);
              emergencyStopGroupsRef.current.forEach(groupId => {
                if (safeGroupStates[groupId]) safeGroupStates[groupId] = {
                  ...safeGroupStates[groupId],
                  autoPilot: {
                    ...safeGroupStates[groupId].autoPilot,
                    enabled: false,
                    remainingRounds: 0,
                    activeBotIds: []
                  }
                };
              });
              remoteSnapshot = {
                ...remoteSnapshot,
                groupStates: safeGroupStates
              };
            }
            const localSnapshot = snapshotRef.current;
            if (remoteSnapshot && (!localSnapshot || (remoteSnapshot.savedAt || 0) > (localSnapshot.savedAt || 0))) {
              applyPersistedState(remoteSnapshot);
            } else if (localSnapshot && (localSnapshot.savedAt || 0) > (remoteSnapshot?.savedAt || 0)) {
              ws.send(JSON.stringify({
                action: 'SAVE_STATE',
                payload: localSnapshot
              }));
            }
            return;
          }
          if (data.type === 'BOT_PROGRESS') {
            handleBotProgress(data);
            return;
          }
          if (data.type === 'BOT_CANCELLED') {
            if (data.requestId) cancelledRequestIdsRef.current.delete(data.requestId);
            return;
          }
          if (data.type === 'BOT_ERROR') {
            if (data.requestId && cancelledRequestIdsRef.current.has(data.requestId)) {
              cancelledRequestIdsRef.current.delete(data.requestId);
              return;
            }
            const failedState = botDispatchStatesRef.current.get(data.botId);
            const failedGroupId = data.groupId || failedState?.groupId || activeGroupIdRef.current;
            const errText = data.message || '网页 AI 没有返回消息';
            const hitRisk = featureSettingsRef.current.circuitBreakOnRisk && isRiskControlTriggered(errText);
            if (failedGroupId) updateGroupState(failedGroupId, state => ({
              ...state,
              lastDispatchError: {
                botId: data.botId,
                message: errText,
                at: Date.now()
              },
              circuitBrokenBots: hitRisk ? {
                ...(state.circuitBrokenBots || {}),
                [data.botId]: errText.slice(0, 60)
              } : state.circuitBrokenBots
            }));
            setTypingBots(previous => previous.filter(id => id !== data.botId));
            if (hitRisk) {
              stopAutoPilot(failedGroupId, true);
              triggerIslandAlert(`🛡️ 检测到风控/限流特征，已主动熔断暂停`, `${botsRef.current.find(b => b.id === data.botId)?.name || 'AI'}：${errText.slice(0, 48)}`, 'SAFE', 'from-rose-500 to-red-600', 6000);
              if (data.botId) finishBotDispatch(data.botId, data.requestId);
              return;
            }
            showToast(errText);
            if (failedState?.options?.summaryMode && failedGroupId) {
              createConclusionCard(failedGroupId, '', failedState.options.autoPilotRunId);
            } else if (failedState?.options?.autoPilotTurn && failedGroupId) {
              if (featureSettingsRef.current.skipStalledTab) advanceAutoPilotAfterReply(failedGroupId, data.botId, failedState.options.autoPilotRunId);else stopAutoPilot(failedGroupId);
            }
            if (data.botId) finishBotDispatch(data.botId, data.requestId);
            return;
          }
          if (data.type === 'BOT_REPLY') {
            if (data.requestId && cancelledRequestIdsRef.current.has(data.requestId)) {
              cancelledRequestIdsRef.current.delete(data.requestId);
              return;
            }
            const bot = botsRef.current.find(b => b.id === data.botId);
            if (!bot) {
              finishBotDispatch(data.botId, data.requestId);
              return;
            }
            const dispatchState = botDispatchStatesRef.current.get(bot.id);
            if (data.requestId && dispatchState?.requestId && data.requestId !== dispatchState.requestId) return;
            const replyGroupId = data.groupId || dispatchState?.groupId || activeGroupIdRef.current;

            // 敏感报错与限流词主动熔断检测（网页把 Cloudflare / Rate limit 提示当作回复文本吐出时立即拦截并熔断）
            if (featureSettingsRef.current.circuitBreakOnRisk && isRiskControlTriggered(data.text || '')) {
              setTypingBots(previous => previous.filter(id => id !== bot.id));
              finishBotDispatch(bot.id, data.requestId);
              updateGroupState(replyGroupId, state => ({
                ...state,
                circuitBrokenBots: {
                  ...(state.circuitBrokenBots || {}),
                  [bot.id]: String(data.text || '').slice(0, 60)
                }
              }));
              stopAutoPilot(replyGroupId, true);
              triggerIslandAlert(`🛡️ ${bot.name} 命中限流/验证词，已自动熔断`, '已停止自动值守与重试，请切到 Chrome 人工检查该网页', 'SAFE', 'from-rose-500 to-red-600', 6000);
              return;
            }
            const dispatchBatchId = dispatchState?.options?.dispatchBatchId;
            const batch = dispatchBatchId ? messageStartWinnersRef.current.get(dispatchBatchId) : null;
            if (batch && !batch.winner) {
              batch.winner = bot.id;
              updateGroupState(replyGroupId, state => ({
                ...state,
                lastStarterId: bot.id
              }));
            }
            if (dispatchState?.options?.autoPilotTurn) {
              const pilot = groupStatesRef.current[replyGroupId]?.autoPilot;
              if (pilot?.firstSpeakerId === bot.id && !pilot.starterRecorded) {
                updateGroupState(replyGroupId, state => ({
                  ...state,
                  lastStarterId: bot.id,
                  autoPilot: {
                    ...state.autoPilot,
                    starterRecorded: true
                  }
                }));
              }
            }
            if (dispatchState?.options?.raceId) {
              const raceId = dispatchState.options.raceId;
              const race = activeRacesRef.current.get(raceId);
              if (race) {
                if (!race.winner) race.winner = bot.id;
                botDispatchStatesRef.current.forEach((otherState, otherBotId) => {
                  if (otherBotId === bot.id || otherState.options?.raceId !== raceId) return;
                  if (otherState.requestId) cancelledRequestIdsRef.current.add(otherState.requestId);
                  otherState.pendingByGroup?.delete(race.groupId);
                  otherState.inFlight = false;
                  otherState.requestId = null;
                  otherState.groupId = null;
                  setTypingBots(previous => previous.filter(id => id !== otherBotId));
                });
                activeRacesRef.current.delete(raceId);
              }
            }
            if (groupStatesRef.current[replyGroupId]?.lastDispatchError?.botId === bot.id) {
              updateGroupState(replyGroupId, state => ({
                ...state,
                lastDispatchError: null
              }));
            }
            const syncThrough = Number.isFinite(Number(data.syncThrough)) ? Number(data.syncThrough) : dispatchState?.syncThrough;
            // 核心保障：只要 AI 网页真正输出了有效文本，绝对不暗中丢弃，必须实时渲染上屏！
            const isExplicitSilentToken = String(data.text || '').trim() === SILENT_REPLY_TOKEN;
            if (isExplicitSilentToken) {
              if (Number.isFinite(syncThrough)) updateBotCursor(bot.id, replyGroupId, syncThrough);
              if (dispatchState?.personaSignature) markPersonaSynced(bot.id, replyGroupId, dispatchState.personaSignature);
              setTypingBots(previous => previous.filter(id => id !== bot.id));
              finishBotDispatch(bot.id, data.requestId);
              if (dispatchState?.options?.autoPilotTurn) advanceAutoPilotAfterReply(replyGroupId, bot.id, dispatchState.options.autoPilotRunId);
              return;
            }
            const currentMessages = groupMessagesRef.current[replyGroupId] || [];
            if (dispatchState?.options?.summaryMode) {
              if (Number.isFinite(syncThrough)) updateBotCursor(bot.id, replyGroupId, syncThrough);
              if (dispatchState?.personaSignature) markPersonaSynced(bot.id, replyGroupId, dispatchState.personaSignature);
              createConclusionCard(replyGroupId, data.text || '', dispatchState.options.autoPilotRunId);
              setTypingBots(previous => previous.filter(id => id !== bot.id));
              finishBotDispatch(bot.id, data.requestId);
              return;
            }
            const nextId = currentMessages.reduce((maxId, message) => Math.max(maxId, message.id || 0), 0) + 1;
            const now = new Date();
            // AI 回复引用控制：支持「都可引用 / 仅我可引用 / 仅AI可引用 / 部分引用 / 关闭」及多维过滤
            const quotedMessage = resolveBotQuotedMessage(bot.id, currentMessages, replyGroupId);
            const newMessage = {
              id: nextId,
              senderId: bot.id,
              senderName: bot.name,
              text: data.text,
              attachments: normalizeAttachments(data.attachments || data.media || []),
              time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
              syncedTo: [bot.id],
              deltaPayload: data.deltaPayload || '来自真实网页 DOM 抓取',
              replyTo: quotedMessage ? {
                id: quotedMessage.id,
                senderName: quotedMessage.senderName,
                text: quotedMessage.text || '图片/视频'
              } : null
            };
            updateGroupMessages([...currentMessages, newMessage], replyGroupId);
            if (Number.isFinite(syncThrough)) updateBotCursor(bot.id, replyGroupId, syncThrough);
            if (dispatchState?.personaSignature) markPersonaSynced(bot.id, replyGroupId, dispatchState.personaSignature);

            // 累计当前群聊单贴轮数，到达用户设定的阈值（非0即非无限大）时自动暂停值守并提示新建网页对话
            const maxRoundsLimit = Number(featureSettingsRef.current.maxSessionRounds) || 0;
            const nextSessionRounds = (Number(groupStatesRef.current[replyGroupId]?.sessionRounds) || 0) + 1;
            updateGroupState(replyGroupId, state => ({
              ...state,
              sessionRounds: nextSessionRounds
            }));
            if (maxRoundsLimit > 0 && nextSessionRounds >= maxRoundsLimit) {
              setTypingBots(prev => prev.filter(id => id !== data.botId));
              finishBotDispatch(bot.id, data.requestId);
              if (groupStatesRef.current[replyGroupId]?.autoPilot?.enabled) {
                stopAutoPilot(replyGroupId, false);
              }
              if (featureSettingsRef.current.conclusionCard && nextSessionRounds === maxRoundsLimit) {
                requestConclusionCard(replyGroupId);
              }
              triggerIslandAlert(`🔄 本群已聊满 ${nextSessionRounds}/${maxRoundsLimit} 轮`, '避免单贴过长触发风控，建议生成结论卡后新建网页对话 URL', 'NEW', 'from-amber-500 to-orange-600', 5500);
              return;
            }
            setTypingBots(prev => prev.filter(id => id !== data.botId));
            finishBotDispatch(bot.id, data.requestId);
            if (dispatchState?.options?.autoPilotTurn) {
              advanceAutoPilotAfterReply(replyGroupId, bot.id, dispatchState.options.autoPilotRunId);
            } else if (dispatchState?.options?.coAnswerRound === 1) {
              // 共答模式第一轮完成处理：检查是否全员第一轮完成，自动唤起第二轮交叉互评
              const batchId = dispatchState.options.dispatchBatchId;
              const tracker = coAnswerTrackerRef.current.get(batchId);
              if (tracker) {
                tracker.completedRound1.add(bot.id);
                if (tracker.completedRound1.size >= tracker.total && !tracker.round2Triggered) {
                  tracker.round2Triggered = true;
                  triggerIslandAlert('💡 共答第1轮全员完成', '进入第2轮：全员汇总第一轮各家观点进行深度交叉互评', 'CO-OP', 'from-purple-500 to-indigo-600', 3500);
                  const updatedSnapshot = [...currentMessages, newMessage];
                  setTimeout(() => {
                    tracker.participatingIds.forEach(bId => {
                      enqueueBotReply(bId, updatedSnapshot, replyGroupId, 'required', true, {
                        dispatchBatchId: batchId,
                        coAnswerRound: 2
                      });
                    });
                  }, 1200);
                }
              }
            } else if (dispatchState?.options?.coAnswerRound === 2) {
              // 共答模式第二轮互评完成处理
              const batchId = dispatchState.options.dispatchBatchId;
              const tracker = coAnswerTrackerRef.current.get(batchId);
              if (tracker) {
                tracker.completedRound2.add(bot.id);
                if (tracker.completedRound2.size >= tracker.total) {
                  triggerIslandAlert('🎉 共答研讨圆满完成', '两轮独立作答与交叉互评已全部呈现在群聊中', 'DONE', 'from-emerald-500 to-teal-600', 4000);
                }
              }
            } else {
              // 普通群聊接力链条：当上一位 AI 回复完毕后，自动唤醒下一位待发言的 AI（完全动态无上限：支持 3位、4位、5位、10位任意多 AI 连续接力）
              const chainState = activeChainRef.current.get(replyGroupId);
              if (chainState && Array.isArray(chainState.chain) && chainState.chain.length > 0) {
                let nextBot = null;
                // 循环查找下一个有效且未被熔断的 Bot，若中间成员不可用自动安全顺延，绝不断链
                while (chainState.chain.length > 0) {
                  const candidateId = chainState.chain.shift();
                  const candidate = botsRef.current.find(b => b.id === candidateId);
                  const isBroken = groupStatesRef.current[replyGroupId]?.circuitBrokenBots?.[candidateId];
                  if (candidate && candidate.targetUrl && !isBroken) {
                    nextBot = candidate;
                    break;
                  }
                }
                if (nextBot) {
                  const updatedSnapshot = [...currentMessages, newMessage];
                  const delayMode = featureSettingsRef.current.relayDelayMode || 'natural';
                  const relayWaitMs = delayMode === 'instant' ? 400 : delayMode === 'safe' ? 2800 : 1200;
                  setTimeout(() => {
                    enqueueBotReply(nextBot.id, updatedSnapshot, replyGroupId, 'required', true, {
                      handoffContext: String(data.text || '').slice(0, 320)
                    });
                  }, relayWaitMs);
                }
              }
            }
          }
        } catch (err) {
          console.error(err);
        }
      };
      ws.onerror = () => {
        setWsConnected(false);
        if (!silent) showToast('本地网页桥接未连接；消息会保留为未同步状态');
      };
      ws.onclose = () => {
        setWsConnected(false);
        if (wsRef.current === ws) wsRef.current = null;
        botDispatchStatesRef.current.forEach((state, botId) => {
          if (!state.inFlight || !state.groupId) return;
          const previous = state.pendingByGroup.get(state.groupId) || {
            policy: state.responsePolicy || 'required',
            force: false,
            options: {}
          };
          state.pendingByGroup.set(state.groupId, {
            policy: mergeDispatchPolicy(previous.policy, state.responsePolicy || 'required'),
            force: previous.force,
            options: {
              ...previous.options,
              ...(state.options || {})
            }
          });
          state.inFlight = false;
          state.requestId = null;
          setTypingBots(typing => typing.filter(id => id !== botId));
        });
      };
      wsRef.current = ws;
    } catch {
      if (!silent) showToast('无法连接本地网页桥接，请先启动 Chat H 桥接服务');
    }
  };
  const applyPersistedState = snapshot => {
    if (!snapshot || typeof snapshot !== 'object') return;
    if (Array.isArray(snapshot.bots)) setBots(snapshot.bots);
    if (Array.isArray(snapshot.groups)) setGroups(snapshot.groups);
    if (snapshot.groupMessages && typeof snapshot.groupMessages === 'object') setGroupMessages(snapshot.groupMessages);
    if (snapshot.groupStates && typeof snapshot.groupStates === 'object') {
      setGroupStates(restoreGroupStates(snapshot.groupStates, snapshot.groups || groupsRef.current, snapshot.bots || botsRef.current));
    }
    if (snapshot.featureSettings && typeof snapshot.featureSettings === 'object') setFeatureSettings({
      ...DEFAULT_FEATURE_SETTINGS,
      ...snapshot.featureSettings
    });
    if (Array.isArray(snapshot.personaModes)) setPersonaModes(snapshot.personaModes);
    if (typeof snapshot.emergencyDotColor === 'string') setEmergencyDotColor(snapshot.emergencyDotColor);
    if (typeof snapshot.activeGroupId === 'string') setActiveGroupId(snapshot.activeGroupId);
    if (typeof snapshot.dispatchMode === 'string') setDispatchMode(snapshot.dispatchMode);
    if (typeof snapshot.chatSubMode === 'string') setChatSubMode(snapshot.chatSubMode);
    if (typeof snapshot.chatBotLimit === 'number') setChatBotLimit(snapshot.chatBotLimit);
    if (typeof snapshot.pinDisplayMode === 'string') setPinDisplayMode(snapshot.pinDisplayMode);
    if (typeof snapshot.antiPreachSuffix === 'string') setAntiPreachSuffix(snapshot.antiPreachSuffix);
    if (typeof snapshot.darkMode === 'boolean') setDarkMode(snapshot.darkMode);
    if (typeof snapshot.wsUrl === 'string') setWsUrl(snapshot.wsUrl);
    if (typeof snapshot.islandColorId === 'string') setIslandColorId(snapshot.islandColorId);
    if (typeof snapshot.islandIntensity === 'string') setIslandIntensity(snapshot.islandIntensity);
    if (typeof snapshot.islandCustomBg === 'string') setIslandCustomBg(snapshot.islandCustomBg);
    if (typeof snapshot.islandCustomBorder === 'string') setIslandCustomBorder(snapshot.islandCustomBorder);
    if (typeof snapshot.themeId === 'string') setThemeId(snapshot.themeId);
    if (typeof snapshot.bubbleStyleId === 'string') setBubbleStyleId(snapshot.bubbleStyleId);
    if (typeof snapshot.myBubbleColorId === 'string') setMyBubbleColorId(snapshot.myBubbleColorId);
    if (typeof snapshot.myBubbleCustomBg === 'string') setMyBubbleCustomBg(snapshot.myBubbleCustomBg);
    if (typeof snapshot.myBubbleCustomText === 'string') setMyBubbleCustomText(snapshot.myBubbleCustomText);
    if (typeof snapshot.botBubbleMode === 'string') setBotBubbleMode(snapshot.botBubbleMode);
    if (typeof snapshot.botBubbleCustomBg === 'string') setBotBubbleCustomBg(snapshot.botBubbleCustomBg);
    if (typeof snapshot.botBubbleCustomText === 'string') setBotBubbleCustomText(snapshot.botBubbleCustomText);
    if (typeof snapshot.avatarShape === 'string') setAvatarShape(snapshot.avatarShape);
    if (typeof snapshot.windowLayoutMode === 'string') setWindowLayoutMode(snapshot.windowLayoutMode);
    if (snapshot.myProfile && typeof snapshot.myProfile === 'object') setMyProfile(snapshot.myProfile);
    snapshotRef.current = snapshot;
  };
  const buildPersistedSnapshot = () => ({
    version: 2,
    savedAt: Date.now(),
    bots,
    groups,
    activeGroupId,
    groupMessages: Object.fromEntries(Object.entries(groupMessages).map(([gid, list]) => [gid, (list || []).map(m => m.attachments?.length ? {
      ...m,
      attachments: []
    } : m)])),
    groupStates,
    featureSettings,
    personaModes,
    emergencyDotColor,
    dispatchMode,
    antiPreachSuffix,
    islandColorId,
    islandIntensity,
    islandCustomBg,
    islandCustomBorder,
    themeId,
    chatSubMode,
    chatBotLimit,
    pinDisplayMode,
    bubbleStyleId,
    myBubbleColorId,
    myBubbleCustomBg,
    myBubbleCustomText,
    botBubbleMode,
    botBubbleCustomBg,
    botBubbleCustomText,
    avatarShape,
    windowLayoutMode,
    myProfile,
    darkMode,
    wsUrl
  });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let indexedSnapshot = null;
      try {
        indexedSnapshot = await readIndexedAppState();
      } catch (error) {
        console.warn('IndexedDB state load failed', error);
      }
      if (cancelled) return;
      const localSnapshot = readLocalAppState();
      const newest = [initialSavedState, localSnapshot, indexedSnapshot].filter(Boolean).reduce((best, item) => !best || (item.savedAt || 0) >= (best.savedAt || 0) ? item : best, null);
      if (newest) applyPersistedState(newest);
      setPersistenceReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    wsUrlRef.current = wsUrl;
  }, [wsUrl]);
  useEffect(() => {
    if (!persistenceReady || !featureSettings.saveLocal) return undefined;
    if (skipFirstSaveEffectRef.current) {
      skipFirstSaveEffectRef.current = false;
      return undefined;
    }
    const snapshot = buildPersistedSnapshot();
    snapshotRef.current = snapshot;
    const lightweightSnapshot = {
      ...snapshot,
      bots: snapshot.bots.map(bot => bot.avatarType === 'image' ? {
        ...bot,
        imageUrl: ''
      } : bot),
      myProfile: snapshot.myProfile?.avatarType === 'image' ? {
        ...snapshot.myProfile,
        imageUrl: ''
      } : snapshot.myProfile,
      groupMessages: Object.fromEntries(Object.entries(snapshot.groupMessages).map(([groupId, items]) => [groupId, items.map(message => message.attachments?.length ? {
        ...message,
        attachments: []
      } : message)]))
    };
    try {
      window.localStorage.setItem(WEB_H_STATE_KEY, JSON.stringify(lightweightSnapshot));
    } catch (error) {
      console.warn('Local storage is full; using IndexedDB and disk state', error);
    }
    const timer = setTimeout(() => {
      persistenceQueueRef.current = persistenceQueueRef.current.then(() => writeIndexedAppState(snapshot)).catch(error => console.warn('IndexedDB state save failed', error));
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          action: 'SAVE_STATE',
          payload: snapshot
        }));
      }
    }, 450);
    return () => clearTimeout(timer);
  }, [persistenceReady, featureSettings.saveLocal, bots, groups, activeGroupId, groupMessages, groupStates, featureSettings, personaModes, emergencyDotColor, dispatchMode, antiPreachSuffix, islandColorId, islandIntensity, islandCustomBg, islandCustomBorder, themeId, bubbleStyleId, myBubbleColorId, myBubbleCustomBg, myBubbleCustomText, botBubbleMode, botBubbleCustomBg, botBubbleCustomText, avatarShape, windowLayoutMode, myProfile, darkMode, wsUrl]);
  useEffect(() => {
    if (!persistenceReady) return undefined;
    if (wsRef.current && wsRef.current.url !== wsUrl) wsRef.current.close(1000, 'Bridge URL changed');
    connectLocalBridge(true);
    const retryTimer = setInterval(() => connectLocalBridge(true), 2500);
    return () => clearInterval(retryTimer);
  }, [persistenceReady, wsUrl, bridgeTransportMode]);
  const generatePlaywrightCode = () => bridgeSource;
  const generateUserscriptCode = () => '// 已停用 Tampermonkey 自动发送脚本：它不支持跨群值守和可靠的后台焦点隔离。请使用项目根目录的 bridge.js。';
  const totalPendingIncrements = bots.reduce((acc, b) => acc + (activeGroup?.memberIds?.includes(b.id) ? getUnreadMessagesForBot(b.id).length : 0), 0);
  const activeModeLabel = dispatchMode === 'smart-chain' ? '群聊模式' : dispatchMode === 'co-answer' || dispatchMode === 'parallel' ? '共答模式' : '指令模式';
  const activeTabLabel = activeTab === 'chat' ? '群聊空间' : activeTab === 'webview' ? '应用内嵌 AI 浏览器' : activeTab === 'sync' ? '指定网页绑定' : activeTab === 'anti-preach' ? '去说教人设' : activeTab === 'settings' ? '外观与头像定制' : activeTab === 'bridge' ? '桥接脚本' : '外观设置';
  const currentTheme = THEME_PRESETS.find(t => t.id === themeId) || THEME_PRESETS[0];
  const handleSelectTheme = newThemeId => {
    const found = THEME_PRESETS.find(t => t.id === newThemeId);
    if (!found) return;
    setThemeId(newThemeId);
    setDarkMode(found.dark);
  };
  const handleToggleDarkLight = () => {
    const nextDark = !darkMode;
    setDarkMode(nextDark);
    setThemeId(nextDark ? 'apple-dark' : 'apple-light');
  };
  const currentIslandPreset = ISLAND_PRESETS.find(p => p.id === islandColorId) || ISLAND_PRESETS[0];
  const activeIslandStyle = currentIslandPreset[islandIntensity] || currentIslandPreset.balanced || currentIslandPreset.subtle || currentIslandPreset;
  const isIslandLight = islandGradientMode === 'advanced' ? false : islandColorId === 'custom' ? (getContrastRatio(islandCustomBg, '#FFFFFF') || 4.5) < 2.2 : currentIslandPreset.isLight;
  const getIslandInlineStyle = () => {
    return {
      background: getIslandThemeBackgroundCss(islandColorId, islandIntensity, islandGradientMode, islandCustomBg),
      ...(islandColorId === 'custom' ? {
        borderColor: islandCustomBorder
      } : {})
    };
  };
  const currentBubbleStyle = BUBBLE_STYLES.find(b => b.id === bubbleStyleId) || BUBBLE_STYLES[0];
  const currentMyBubbleColor = MY_BUBBLE_COLORS.find(c => c.id === myBubbleColorId) || MY_BUBBLE_COLORS[0];
  const pinnedGptBot = bots.find(bot => bot.id === 'chatgpt' || /chatgpt/i.test(bot.platform || '')) || {
    id: 'chatgpt',
    name: 'ChatGPT 4o',
    roleTag: '硅谷增长产品狂',
    platform: 'ChatGPT Web',
    avatarType: 'badge',
    badge: '4o',
    avatarBg: 'from-emerald-400 via-teal-500 to-cyan-600'
  };
  const pinnedGptBubbleStyle = BUBBLE_STYLES.find(style => style.id === pinnedGptBot.bubbleStyleId) || currentBubbleStyle;
  const selectedPreviewBot = selectedAvatarTarget !== 'me' ? bots.find(bot => bot.id === selectedAvatarTarget) : bots.find(bot => bot.id === selectedBubbleBotId) || null;
  const previewBot = selectedPreviewBot || pinnedGptBot;
  const previewBotIsGPT = previewBot.id === pinnedGptBot.id;
  const previewBotBubbleStyle = BUBBLE_STYLES.find(style => style.id === previewBot.bubbleStyleId) || currentBubbleStyle;
  const previewBotColors = previewBot.bubbleCustomEnabled ? [previewBot.bubbleBg || botBubbleCustomBg, previewBot.bubbleText || botBubbleCustomText] : botBubbleMode === 'custom' ? [botBubbleCustomBg, botBubbleCustomText] : null;
  const customContrastRatios = [myBubbleColorId === 'custom' ? getContrastRatio(myBubbleCustomBg, myBubbleCustomText) : null, previewBotColors ? getContrastRatio(previewBotColors[0], previewBotColors[1]) : null].filter(ratio => ratio !== null);
  const lowestCustomContrast = customContrastRatios.length ? Math.min(...customContrastRatios) : null;
  const getBotBubbleInlineStyle = bot => {
    if (bot?.bubbleCustomEnabled) {
      return {
        backgroundColor: bot.bubbleBg || botBubbleCustomBg,
        color: bot.bubbleText || botBubbleCustomText
      };
    }
    if (botBubbleMode === 'custom') return {
      backgroundColor: botBubbleCustomBg,
      color: botBubbleCustomText
    };
    return undefined;
  };
  const getBotBubbleClasses = bot => {
    if (bot?.bubbleCustomEnabled || botBubbleMode === 'custom') {
      return 'border border-black/10 dark:border-white/10 shadow-xs';
    }
    if (botBubbleMode === 'frosted-glass') {
      return darkMode ? 'bg-white/[0.08] backdrop-blur-xl text-zinc-100 border border-white/[0.15] shadow-md' : 'bg-white/60 backdrop-blur-xl text-zinc-800 border border-white/90 shadow-md';
    }
    if (botBubbleMode === 'role-tinted') {
      const tintMap = {
        deepseek: darkMode ? 'bg-blue-950/65 text-blue-100 border border-blue-500/30' : 'bg-blue-50/90 text-blue-950 border border-blue-200/80',
        chatgpt: darkMode ? 'bg-emerald-950/65 text-emerald-100 border border-emerald-500/30' : 'bg-emerald-50/90 text-emerald-950 border border-emerald-200/80',
        kimi: darkMode ? 'bg-purple-950/65 text-purple-100 border border-purple-500/30' : 'bg-purple-50/90 text-purple-950 border border-purple-200/80',
        claude: darkMode ? 'bg-amber-950/65 text-amber-100 border border-amber-500/30' : 'bg-amber-50/90 text-amber-950 border border-amber-200/80'
      };
      if (tintMap[bot?.id]) return tintMap[bot.id];
      const bg = String(bot?.avatarBg || '');
      if (bg.includes('emerald') || bg.includes('teal') || bg.includes('green')) return tintMap.chatgpt;
      if (bg.includes('purple') || bg.includes('fuchsia') || bg.includes('pink')) return tintMap.kimi;
      if (bg.includes('amber') || bg.includes('orange') || bg.includes('rose')) return tintMap.claude;
      return tintMap.deepseek;
    }
    // adaptive default
    return darkMode ? 'bg-zinc-800/90 text-zinc-100 border border-white/[0.07] shadow-sm' : 'bg-white text-zinc-800 border border-zinc-200/80 shadow-sm';
  };
  const renderEntityAvatar = (entity, sizeClass = 'w-9 h-9', textSizeClass = 'text-xs', forceRound = false) => {
    const isMe = entity === 'me' || entity?.id === 'me';
    const data = isMe ? myProfile : entity;
    if (!data) return null;
    const shapeClass = forceRound ? 'rounded-full' : avatarShape;
    const avatarType = data.avatarType || 'badge';
    const customStyle = data.customColor ? {
      background: data.customColor
    } : undefined;
    if (avatarType === 'image' && data.imageUrl) {
      return /*#__PURE__*/React.createElement("img", {
        src: data.imageUrl,
        alt: data.name || 'avatar',
        className: `${sizeClass} ${shapeClass} object-cover shrink-0 shadow-sm ring-1 ring-black/10 dark:ring-white/15`
      });
    }
    return /*#__PURE__*/React.createElement("div", {
      style: customStyle,
      className: `${sizeClass} ${shapeClass} ${!data.customColor ? `bg-gradient-to-br ${data.avatarBg || 'from-blue-500 to-indigo-600'}` : ''} text-white font-bold ${textSizeClass} flex items-center justify-center shrink-0 shadow-sm select-none`
    }, avatarType === 'emoji' ? data.emoji || '🤖' : forceRound ? (data.badge || 'A')[0] : data.badge || 'AI');
  };
  const handleAvatarFileUpload = (e, targetId) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const dataUrl = ev.target?.result;
      if (typeof dataUrl !== 'string') return;
      if (targetId === 'me') {
        setMyProfile(prev => ({
          ...prev,
          avatarType: 'image',
          imageUrl: dataUrl
        }));
      } else {
        setBots(bs => bs.map(b => b.id === targetId ? {
          ...b,
          avatarType: 'image',
          imageUrl: dataUrl
        } : b));
      }
      showToast('已更新自定义图片头像');
    };
    reader.readAsDataURL(file);
  };
  const normalizeAttachments = items => (Array.isArray(items) ? items : []).map((item, index) => {
    const src = typeof item === 'string' ? item : item?.dataUrl || item?.url || item?.src || item?.data;
    if (!src) return null;
    const type = item?.type || (src.startsWith('data:video/') ? 'video/' + '*' : src.startsWith('data:image/') ? 'image/' + '*' : 'application/octet-stream');
    return {
      id: item?.id || `media-${Date.now()}-${index}`,
      name: item?.name || `附件 ${index + 1}`,
      type,
      url: src,
      size: item?.size || 0
    };
  }).filter(Boolean);
  const handleAttachmentFiles = event => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    setUploadMenuOpen(false);
    if (!files.length) return;
    const valid = files.map((file, idx) => {
      const rawType = file.type || (/\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i.test(file.name) ? 'image/png' : /\.(mp4|webm|mov|mkv|avi)$/i.test(file.name) ? 'video/mp4' : 'application/octet-stream');
      const blobUrl = typeof URL !== 'undefined' && URL.createObjectURL ? URL.createObjectURL(file) : '';
      const id = `file-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 7)}`;
      attachmentFilesRef.current.set(id, file);
      return {
        id,
        name: file.name || `附件_${idx + 1}`,
        type: rawType,
        size: file.size || 0,
        url: blobUrl,
        ephemeralInMemoryOnly: true
      };
    });
    setPendingAttachments(previous => [...previous, ...valid]);
    showToast(`已添加 ${valid.length} 个附件；发送时会临时缓存，并在网页完成处理后自动清理`);
  };
  const startNewGroup = () => {
    setGroupDraft({
      id: null,
      name: '',
      memberIds: activeBots.map(bot => bot.id)
    });
    setGroupEditorOpen(true);
  };
  const startEditGroup = group => {
    setGroupDraft({
      id: group.id,
      name: group.name,
      memberIds: [...(group.memberIds || [])]
    });
    setGroupEditorOpen(true);
  };
  const saveGroup = () => {
    const name = groupDraft.name.trim();
    if (!name) return showToast('请先填写群聊名称');
    const memberIds = groupDraft.memberIds.filter(id => bots.some(bot => bot.id === id));
    if (groupDraft.id) {
      const prevGrp = groups.find(g => g.id === groupDraft.id);
      const prevMembers = new Set(prevGrp?.memberIds || []);
      const newlyJoinedBotIds = memberIds.filter(id => !prevMembers.has(id));
      setGroups(previous => previous.map(group => group.id === groupDraft.id ? {
        ...group,
        name,
        memberIds
      } : group));
      const currentPinnedIds = groupStatesRef.current[groupDraft.id]?.pinnedMessageIds || [];
      if (newlyJoinedBotIds.length > 0 && currentPinnedIds.length > 0) {
        setTimeout(() => notifyBotsOfPinnedMessagesOnce(groupDraft.id, currentPinnedIds, newlyJoinedBotIds), 120);
      }
    } else {
      const id = `group-${Date.now()}`;
      setGroups(previous => [...previous, {
        id,
        name,
        memberIds,
        subtitle: '新建群聊',
        time: '现在',
        unread: 0
      }]);
      setGroupMessages(previous => ({
        ...previous,
        [id]: []
      }));
      setActiveGroupId(id);
      setActiveTab('chat');
    }
    setGroupEditorOpen(false);
    showToast('群聊设置已保存');
  };
  const deleteGroup = groupId => {
    if (groups.length <= 1) return showToast('至少保留一个群聊');
    stopAutoPilot(groupId, true);
    const remaining = groups.filter(group => group.id !== groupId);
    setGroups(remaining);
    const remainingMessages = {
      ...groupMessagesRef.current
    };
    delete remainingMessages[groupId];
    groupMessagesRef.current = remainingMessages;
    setGroupMessages(remainingMessages);
    setGroupStates(previous => {
      const next = {
        ...previous
      };
      delete next[groupId];
      groupStatesRef.current = next;
      return next;
    });
    if (activeGroupId === groupId) setActiveGroupId(remaining[0].id);
    setGroupEditorOpen(false);
    showToast('群聊已删除');
  };
  const startNewBot = () => {
    setBotDraft({
      templateId: '',
      name: '',
      roleTag: '',
      platform: '自定义网页 AI',
      targetUrl: '',
      selectorInput: 'div[contenteditable="true"]',
      selectorSend: 'button[type="submit"]',
      persona: '',
      badge: 'AI'
    });
    setBotEditorOpen(true);
  };
  const saveBot = () => {
    const name = botDraft.name.trim();
    if (!name) return showToast('请先填写聊天人昵称');
    const template = bots.find(bot => bot.id === botDraft.templateId);
    const newId = `ai-${Date.now()}`;
    const platformDefaults = {
      'ChatGPT': {
        targetUrl: 'https://chatgpt.com/',
        selectorInput: '#prompt-textarea',
        selectorSend: 'button[data-testid="send-button"]'
      },
      'Claude': {
        targetUrl: 'https://claude.ai/new',
        selectorInput: 'div.ProseMirror[contenteditable="true"]',
        selectorSend: 'button[aria-label="Send Message"]'
      },
      'DeepSeek': {
        targetUrl: 'https://chat.deepseek.com/',
        selectorInput: '#chat-input',
        selectorSend: 'div[role="button"].ds-send-btn'
      },
      'Kimi': {
        targetUrl: 'https://www.kimi.com/',
        selectorInput: 'div[contenteditable="true"].chat-input',
        selectorSend: 'button.send-button'
      },
      'Gemini': {
        targetUrl: 'https://gemini.google.com/app',
        selectorInput: 'rich-textarea [contenteditable="true"]',
        selectorSend: 'button[data-test-id="send-button"]'
      },
      '豆包': {
        targetUrl: 'https://www.doubao.com/chat/',
        selectorInput: '[contenteditable="true"]',
        selectorSend: 'button[aria-label*="发送"]'
      },
      '千问': {
        targetUrl: 'https://chat.qwen.ai/',
        selectorInput: '[contenteditable="true"]',
        selectorSend: 'button[aria-label*="发送"]'
      },
      '自定义网页 AI': {
        targetUrl: '',
        selectorInput: 'div[contenteditable="true"]',
        selectorSend: 'button[type="submit"]'
      }
    }[botDraft.platform] || {};
    const bot = {
      ...(template || {}),
      id: newId,
      name,
      roleTag: botDraft.roleTag.trim() || '自定义聊天人',
      platform: botDraft.platform || template?.platform || '自定义网页 AI',
      targetUrl: botDraft.targetUrl || template?.targetUrl || platformDefaults.targetUrl || '',
      selectorInput: botDraft.selectorInput || template?.selectorInput || platformDefaults.selectorInput,
      selectorSend: botDraft.selectorSend || template?.selectorSend || platformDefaults.selectorSend,
      persona: botDraft.persona.trim(),
      badge: (botDraft.badge || 'AI').slice(0, 3),
      status: 'connected',
      syncCursor: 0,
      syncCursorByGroup: Object.fromEntries(groups.map(group => [group.id, 0])),
      SampleReplies: template?.SampleReplies || ['收到，我来补充一个角度。', '这个想法可以，我再具体看一下。', '我理解你的意思，继续聊聊。']
    };
    setBots(previous => {
      const next = [...previous, bot];
      botsRef.current = next;
      return next;
    });
    setGroups(previous => previous.map(group => group.id === activeGroupId ? {
      ...group,
      memberIds: [...new Set([...(group.memberIds || []), newId])]
    } : group));
    setSelectedAvatarTarget(newId);
    setBotEditorOpen(false);
    const currentPinnedIds = groupStatesRef.current[activeGroupId]?.pinnedMessageIds || [];
    if (currentPinnedIds.length > 0) {
      setTimeout(() => notifyBotsOfPinnedMessagesOnce(activeGroupId, currentPinnedIds, [newId]), 120);
    } else {
      showToast(`${name} 已加入当前群聊`);
    }
  };
  const removeBot = botId => {
    if (bots.length <= 1) return showToast('至少保留一个 AI 聊天人');
    setBots(previous => previous.filter(bot => bot.id !== botId));
    setGroups(previous => previous.map(group => ({
      ...group,
      memberIds: (group.memberIds || []).filter(id => id !== botId)
    })));
    if (selectedAvatarTarget === botId) setSelectedAvatarTarget('me');
    showToast('聊天人已移除');
  };

  // macOS Traffic Light Window Controls (Works in Electron Desktop + Browser Fullscreen/Mini Mode)
  const sendElectronCommand = cmd => {
    try {
      // Method 1: Preload / window bridge if available
      if (window.electronAPI && typeof window.electronAPI[cmd] === 'function') {
        window.electronAPI[cmd]();
        return true;
      }
      // Method 2: Title signal intercepted by electron-main.cjs (Zero-config IPC!)
      const prevTitle = document.title;
      document.title = `__ELECTRON_CMD__:${cmd}:${Date.now()}`;
      setTimeout(() => {
        document.title = prevTitle || 'Chat H';
      }, 60);
    } catch {
      // Ignore in sandbox
    }
    return false;
  };
  const handleWindowClose = () => {
    sendElectronCommand('close');
    try {
      window.close();
    } catch {
      // Fallback in browser/sandbox
    }
    showToast('已发送关闭窗口指令（浏览器模式下已收起侧栏）');
    setShowLeftSidebar(false);
    setShowRightDrawer(false);
  };
  const handleWindowMinimize = () => {
    sendElectronCommand('minimize');
    setIsMinimizedToIsland(prev => {
      const next = !prev;
      showToast(next ? '已最小化为「仅灵动岛悬浮条」模式（再点黄色按钮恢复）' : '已恢复完整群聊窗口');
      return next;
    });
  };
  const handleWindowMaximize = () => {
    sendElectronCommand('maximize');
    setIsWindowMaximized(prev => !prev);
    try {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen?.();
      } else {
        document.exitFullscreen?.();
      }
    } catch {
      // Fallback if fullscreen blocked
    }
    showToast(isWindowMaximized ? '已还原窗口默认尺寸' : '已切换全屏/最大化窗口模式');
  };
  const handleResetAppearance = () => {
    setIslandColorId('obsidian');
    setIslandCustomBg('#141824');
    setIslandCustomBorder('#38bdf8');
    handleSelectTheme('apple-light');
    setBubbleStyleId('imessage');
    setMyBubbleColorId('apple-blue');
    setBotBubbleMode('adaptive');
    setAvatarShape('rounded-2xl');
    setEmergencyDotColor('#FF5F56');
    setPinDisplayMode('both');
    setFeatureSettings(prev => ({
      ...prev,
      unreadBadgeShape: 'pill',
      unreadBadgeSize: 'md',
      unreadBadgeColor: '#FF3B30'
    }));
    setMyProfile({
      name: '我 (主理人)',
      badge: '我',
      avatarType: 'badge',
      emoji: '🧑‍💻',
      imageUrl: '',
      avatarBg: 'from-blue-600 via-indigo-500 to-violet-600',
      customColor: ''
    });
    setBots(previous => previous.map(bot => {
      const initial = INITIAL_BOTS.find(item => item.id === bot.id);
      return {
        ...bot,
        bubbleStyleId: undefined,
        bubbleCustomEnabled: false,
        bubbleBg: undefined,
        bubbleText: undefined,
        ...(initial ? {
          avatarType: undefined,
          avatarBg: initial.avatarBg,
          ringColor: initial.ringColor,
          dotColor: initial.dotColor,
          badge: initial.badge,
          customColor: '',
          imageUrl: '',
          emoji: undefined
        } : {
          customColor: '',
          avatarType: 'badge'
        })
      };
    }));
    showToast('已恢复默认 Apple 原生外观与头像配置');
  };

  // ============================================================================
  // 应用内嵌多标签 AI 浏览器渲染器 (支持「上下同屏」与「全屏内嵌网页标签页」双形态)
  // ============================================================================
  const renderInAppBrowserContainer = (isSplitMode = false) => {
    const currentWebBot = bots.find(b => b.id === activeWebViewBotId) || bots[0];
    if (!currentWebBot) return null;
    const boundUrl = (currentWebBot.targetUrl || 'https://chat.deepseek.com/').trim();
    const tabData = inAppBrowserTabs[currentWebBot.id] || {
      url: boundUrl,
      browsingUrl: null,
      loggedIn: true,
      isGenerating: false,
      draftInput: '',
      lastInjectedAt: '就绪',
      turns: [],
      sessionsByUrl: {}
    };
    const currentRealUrl = (tabData.browsingUrl || boundUrl).trim();
    const isStrictlyMatchedUrl = currentRealUrl === boundUrl;
    const activeTurns = tabData.sessionsByUrl && tabData.sessionsByUrl[currentRealUrl] || tabData.turns || [];
    const handleCopyCurrentWebUrl = () => {
      handleCopy(currentRealUrl, 'copy-current-web-url');
      showToast('📋 已复制当前页面真实网址，可去「绑定/人设」粘贴绑定！');
    };
    const buildDemoAiMediaAttachments = botName => {
      const svgXml = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270" viewBox="0 0 480 270"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0ea5e9"/><stop offset="50%" stop-color="#6366f1"/><stop offset="100%" stop-color="#a855f7"/></linearGradient></defs><rect width="480" height="270" rx="24" fill="url(#g)"/><circle cx="390" cy="70" r="45" fill="rgba(255,255,255,0.18)"/><rect x="32" y="160" width="416" height="78" rx="16" fill="rgba(255,255,255,0.2)"/><text x="48" y="196" fill="#fff" font-size="20" font-family="sans-serif" font-weight="bold">${botName} 生成的渲染图 (内存直传)</text><text x="48" y="222" fill="rgba(255,255,255,0.85)" font-size="13" font-family="sans-serif">复制仅记忆一次 · 阅后即焚不占用手机闪存</text></svg>`;
      const imgDataUrl = 'data:image/svg+xml;utf8,' + encodeURIComponent(svgXml);
      return [{
        id: 'ephemeral-img-' + Date.now(),
        name: `${botName.split(' ')[0]}_生成架构图.png`,
        type: 'image/svg+xml',
        url: imgDataUrl,
        ephemeralInMemoryOnly: true
      }, {
        id: 'ephemeral-file-' + (Date.now() + 1),
        name: `${botName.split(' ')[0]}_完整方案代码包.zip`,
        type: 'application/zip',
        size: 128400,
        url: 'data:text/plain;utf8,' + encodeURIComponent('AI Generated Code Archive'),
        ephemeralInMemoryOnly: true
      }];
    };
    const handleCopyAiTurnOnce = (turn, includeDemoMedia = false) => {
      const mediaList = includeDemoMedia ? [...(turn.attachments || []), ...buildDemoAiMediaAttachments(currentWebBot.name)] : turn.attachments || [];
      storeOneTimeEphemeralAiCopy({
        botId: currentWebBot.id,
        text: turn.text || '',
        attachments: mediaList
      });
      showToast(`📥 已复制 ${currentWebBot.name.split(' ')[0]} 的回复${mediaList.length ? `及 ${mediaList.length} 个图片/文件` : ''}（仅记忆一次·不占内存，回群聊点左下角 + 即可接收）`);
    };
    const handleManualWebSend = () => {
      const text = (tabData.draftInput || '').trim();
      if (!text) return;
      const nowTime = new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit'
      });
      const syncCursor = getCursorForBot(currentWebBot.id, activeGroupId);
      const reply = synthesizeInAppWebReply(currentWebBot, {
        botId: currentWebBot.id,
        payload: text,
        groupId: activeGroupId,
        syncThrough: syncCursor
      });
      const wantsMedia = /图|视频|文件|代码|方案|表|pdf|zip/i.test(text);
      const replyAttachments = wantsMedia ? buildDemoAiMediaAttachments(currentWebBot.name) : [];
      const uId = Date.now();
      const aId = uId + 1;
      setInAppBrowserTabs(prev => {
        const cur = prev[currentWebBot.id] || tabData;
        const sessions = {
          ...(cur.sessionsByUrl || {})
        };
        const prevTurns = sessions[currentRealUrl] || cur.turns || [];
        const nextTurns = [...prevTurns.slice(-12), {
          id: uId,
          role: 'user',
          text,
          time: nowTime
        }, {
          id: aId,
          role: 'assistant',
          text: '正在思考…▍',
          time: nowTime,
          streaming: true,
          attachments: []
        }];
        sessions[currentRealUrl] = nextTurns;
        return {
          ...prev,
          [currentWebBot.id]: {
            ...cur,
            draftInput: '',
            isGenerating: true,
            sessionsByUrl: sessions,
            turns: nextTurns
          }
        };
      });
      setTimeout(() => {
        setInAppBrowserTabs(prev => {
          const cur = prev[currentWebBot.id] || tabData;
          const sessions = {
            ...(cur.sessionsByUrl || {})
          };
          const updatedTurns = (sessions[currentRealUrl] || cur.turns || []).map(t => t.id === aId ? {
            ...t,
            text: reply,
            streaming: false,
            attachments: replyAttachments
          } : t);
          sessions[currentRealUrl] = updatedTurns;
          return {
            ...prev,
            [currentWebBot.id]: {
              ...cur,
              isGenerating: false,
              sessionsByUrl: sessions,
              turns: updatedTurns
            }
          };
        });
        if (currentRealUrl === boundUrl && wsRef.current && typeof wsRef.current.onmessage === 'function') {
          wsRef.current.onmessage({
            data: JSON.stringify({
              type: 'BOT_REPLY',
              botId: currentWebBot.id,
              groupId: activeGroupId,
              syncThrough: syncCursor,
              text: reply,
              attachments: replyAttachments,
              deltaPayload: text
            })
          });
        } else if (currentRealUrl !== boundUrl) {
          showToast('当前为未绑定对话框，仅在网页内对话（如需接收至群聊可点气泡下方「单次复制回复/媒体」）');
        }
      }, 320);
    };
    const handleSwitchNewDialogInBrowser = () => {
      const slug = Math.random().toString(36).slice(2, 10);
      const baseOrigin = (() => {
        try {
          const u = new URL(boundUrl);
          return u.origin;
        } catch (_e) {
          return 'https://chatgpt.com';
        }
      })();
      const newUrl = baseOrigin.includes('deepseek') ? `${baseOrigin}/a/chat/s/${slug}` : baseOrigin.includes('claude') ? `${baseOrigin}/chat/${slug}` : `${baseOrigin}/c/${slug}`;
      setInAppBrowserTabs(prev => {
        const cur = prev[currentWebBot.id] || tabData;
        const sessions = {
          ...(cur.sessionsByUrl || {})
        };
        sessions[newUrl] = [{
          id: Date.now(),
          role: 'assistant',
          text: '✨ 已切换到新的网页对话框。如需将此对话框设为群聊固定接收地址，请点击上方「复制网址」并前往「绑定/人设」粘贴保存。',
          time: new Date().toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
          })
        }];
        return {
          ...prev,
          [currentWebBot.id]: {
            ...cur,
            browsingUrl: newUrl,
            sessionsByUrl: sessions,
            turns: sessions[newUrl]
          }
        };
      });
      if (window.AndroidWebHBridge && typeof window.AndroidWebHBridge.postCommand === 'function' && webViewRenderMode === 'native-iframe') {
        try {
          window.AndroidWebHBridge.postCommand(JSON.stringify({
            action: 'NAVIGATE_WEBVIEW',
            botId: currentWebBot.id,
            targetUrl: newUrl
          }));
        } catch (_e) {}
      }
      showToast('已切换新对话框（可点击「复制网址」去绑定）');
    };
    return /*#__PURE__*/React.createElement("div", {
      className: `flex flex-col overflow-hidden transition-all ${isSplitMode ? `h-48 mx-3 mt-1 mb-1.5 rounded-2xl border shadow-lg shrink-0 ${darkMode ? 'bg-zinc-900/95 border-white/15' : 'bg-white/95 border-zinc-200/90'}` : 'flex-1 min-h-0 mx-3 mb-2 rounded-3xl border shadow-lg ' + (darkMode ? 'bg-zinc-900/85 border-white/15' : 'bg-white/85 border-zinc-200/90')}`
    }, /*#__PURE__*/React.createElement("div", {
      className: `px-2.5 py-2 border-b flex flex-wrap items-center justify-between gap-1.5 shrink-0 ${darkMode ? 'bg-black/40 border-white/10' : 'bg-zinc-100/90 border-zinc-200/80'}`
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex items-center gap-1 overflow-x-auto no-scrollbar"
    }, bots.map(b => {
      const isTabActive = b.id === currentWebBot.id;
      const bTab = inAppBrowserTabs[b.id];
      const isBusy = typingBots.includes(b.id) || bTab?.isGenerating;
      return /*#__PURE__*/React.createElement("button", {
        key: b.id,
        type: "button",
        onClick: () => setActiveWebViewBotId(b.id),
        className: `px-2.5 py-1 rounded-xl text-[11px] font-medium flex items-center gap-1 shrink-0 transition-all ${isTabActive ? darkMode ? 'bg-zinc-800 text-white shadow-xs ring-1 ring-white/15 font-semibold' : 'bg-white text-zinc-900 shadow-xs ring-1 ring-black/5 font-semibold' : 'opacity-60 hover:opacity-100'}`
      }, renderEntityAvatar(b, 'w-3.5 h-3.5', 'text-[7px]', true), /*#__PURE__*/React.createElement("span", null, b.name.split(' ')[0]), isBusy ? /*#__PURE__*/React.createElement("span", {
        className: "w-1.5 h-1.5 rounded-full bg-blue-500 animate-ping"
      }) : /*#__PURE__*/React.createElement("span", {
        className: "w-1.5 h-1.5 rounded-full bg-emerald-500"
      }));
    })), /*#__PURE__*/React.createElement("div", {
      className: "flex items-center gap-1 shrink-0"
    }, /*#__PURE__*/React.createElement("button", {
      type: "button",
      onClick: handleCopyCurrentWebUrl,
      className: "px-2.5 py-1 rounded-xl bg-[#007AFF] hover:bg-blue-600 text-white text-[10px] font-semibold flex items-center gap-1 shadow-xs",
      title: "\u5B9E\u65F6\u590D\u5236\u5F53\u524D\u6B63\u5728\u6D4F\u89C8\u7684\u5BF9\u8BDD\u9875\u9762\u7F51\u5740"
    }, copiedKey === 'copy-current-web-url' ? /*#__PURE__*/React.createElement(Check, {
      className: "w-3 h-3"
    }) : /*#__PURE__*/React.createElement(Copy, {
      className: "w-3 h-3"
    }), /*#__PURE__*/React.createElement("span", null, copiedKey === 'copy-current-web-url' ? '已复制网址' : '复制网址')), /*#__PURE__*/React.createElement("button", {
      type: "button",
      onClick: handleSwitchNewDialogInBrowser,
      className: `px-2 py-1 rounded-xl border text-[10px] font-medium ${darkMode ? 'bg-white/5 border-white/10 text-zinc-200' : 'bg-white border-zinc-200 text-zinc-700'}`
    }, "\u6362\u65B0\u5BF9\u8BDD"), !isStrictlyMatchedUrl && /*#__PURE__*/React.createElement("button", {
      type: "button",
      onClick: () => setInAppBrowserTabs(prev => ({
        ...prev,
        [currentWebBot.id]: {
          ...tabData,
          browsingUrl: null
        }
      })),
      className: "px-2 py-1 rounded-xl bg-amber-500/15 text-amber-600 dark:text-amber-300 text-[10px] font-semibold"
    }, "\u56DE\u7ED1\u5B9A\u9875"), !isSplitMode && /*#__PURE__*/React.createElement("button", {
      type: "button",
      onClick: () => setWebViewRenderMode(m => m === 'interactive-dom' ? 'native-iframe' : 'interactive-dom'),
      className: `px-2 py-1 rounded-xl border text-[10px] font-semibold ${webViewRenderMode === 'native-iframe' ? 'bg-purple-600 text-white border-purple-600' : darkMode ? 'bg-blue-500/15 border-blue-400/30 text-blue-300' : 'bg-blue-50 border-blue-200 text-blue-700'}`
    }, webViewRenderMode === 'interactive-dom' ? '真机网页' : '内置快聊'), isSplitMode && /*#__PURE__*/React.createElement("button", {
      type: "button",
      onClick: () => setSplitWebViewOpen(false),
      className: "p-1 rounded-lg opacity-70 hover:opacity-100"
    }, /*#__PURE__*/React.createElement(X, {
      className: "w-4 h-4"
    })))), webViewRenderMode === 'native-iframe' && !isSplitMode ? /*#__PURE__*/React.createElement("div", {
      className: "flex-1 flex flex-col min-h-0 relative bg-zinc-950 text-zinc-200"
    }, /*#__PURE__*/React.createElement("div", {
      className: "px-3 py-1.5 bg-zinc-900 border-b border-white/10 flex items-center justify-between gap-2 text-[11px]"
    }, /*#__PURE__*/React.createElement("span", {
      className: "truncate opacity-80"
    }, "\u771F\u673A\u7F51\u9875\u6A21\u5F0F \xB7 \u590D\u5236 AI \u56DE\u590D\u6216\u5A92\u4F53\u540E\u53EF\u56DE\u7FA4\u804A\u4E00\u952E\u7C98\u8D34\uFF08\u4EC5\u8BB0\u5FC6\u4E00\u6B21\uFF09"), /*#__PURE__*/React.createElement("button", {
      type: "button",
      onClick: () => setWebViewRenderMode('interactive-dom'),
      className: "px-2.5 py-1 rounded-lg bg-[#007AFF] text-white text-[10px] font-semibold shrink-0"
    }, "\u5207\u56DE\u5185\u7F6E\u5FEB\u804A")), /*#__PURE__*/React.createElement("iframe", {
      title: `Embedded-${currentWebBot.name}`,
      src: currentRealUrl,
      className: "flex-1 w-full border-0 bg-white",
      sandbox: "allow-scripts allow-same-origin allow-forms"
    })) : /*#__PURE__*/React.createElement("div", {
      className: "flex-1 flex flex-col min-h-0 overflow-hidden"
    }, !isStrictlyMatchedUrl && /*#__PURE__*/React.createElement("div", {
      className: "px-3 py-1 bg-amber-500/15 text-amber-700 dark:text-amber-300 text-[10px] flex items-center justify-between"
    }, /*#__PURE__*/React.createElement("span", null, "\uD83D\uDD12 \u5F53\u524D\u5904\u4E8E\u672A\u7ED1\u5B9A\u65B0\u5BF9\u8BDD\u6846\uFF0C\u7FA4\u804A\u4ECD\u4E25\u683C\u4ECE\u539F\u7ED1\u5B9A\u7F51\u5740\u6536\u53D1\u6D88\u606F"), /*#__PURE__*/React.createElement("button", {
      type: "button",
      onClick: () => {
        setBots(prev => prev.map(b => b.id === currentWebBot.id ? {
          ...b,
          targetUrl: currentRealUrl
        } : b));
        showToast('已将当前对话框网址设为 ' + currentWebBot.name + ' 的固定接收地址！');
      },
      className: "underline font-semibold ml-2 shrink-0"
    }, "\u7ED1\u5B9A\u6B64\u5BF9\u8BDD")), /*#__PURE__*/React.createElement("div", {
      className: "flex-1 overflow-y-auto px-3.5 py-3 space-y-3 text-xs"
    }, activeTurns.map(turn => /*#__PURE__*/React.createElement("div", {
      key: turn.id,
      className: `flex flex-col ${turn.role === 'user' ? 'items-end' : 'items-start'}`
    }, /*#__PURE__*/React.createElement("div", {
      className: "text-[10px] opacity-45 mb-1 px-1"
    }, turn.role === 'user' ? `我 · ${turn.time}` : `${currentWebBot.name} · ${turn.time}`), /*#__PURE__*/React.createElement("div", {
      className: `max-w-[88%] rounded-2xl px-3.5 py-2.5 text-xs leading-relaxed whitespace-pre-wrap ${turn.role === 'user' ? 'bg-[#007AFF] text-white' : darkMode ? 'bg-zinc-800 text-zinc-100 border border-white/10' : 'bg-zinc-100 text-zinc-900 border border-zinc-200/80'}`
    }, turn.text), turn.role === 'assistant' && /*#__PURE__*/React.createElement("div", {
      className: "flex items-center gap-2 mt-1 px-1"
    }, /*#__PURE__*/React.createElement("button", {
      type: "button",
      onClick: () => handleCopyAiTurnOnce(turn, false),
      className: "text-[10px] text-[#007AFF] font-semibold flex items-center gap-1 hover:underline"
    }, /*#__PURE__*/React.createElement(Copy, {
      className: "w-3 h-3"
    }), /*#__PURE__*/React.createElement("span", null, "\u5355\u6B21\u590D\u5236\u56DE\u590D\u81F3\u7FA4\u804A")), /*#__PURE__*/React.createElement("button", {
      type: "button",
      onClick: () => handleCopyAiTurnOnce(turn, true),
      className: "text-[10px] text-emerald-600 dark:text-emerald-400 font-semibold flex items-center gap-1 hover:underline"
    }, /*#__PURE__*/React.createElement(Download, {
      className: "w-3 h-3"
    }), /*#__PURE__*/React.createElement("span", null, "\u8FDE\u540CAI\u56FE\u7247/\u6587\u4EF6\u5355\u6B21\u590D\u5236(\u96F6\u5185\u5B58)")))))), /*#__PURE__*/React.createElement("div", {
      className: `px-3 py-2 border-t flex items-center gap-2 shrink-0 ${darkMode ? 'bg-black/40 border-white/10' : 'bg-zinc-50 border-zinc-200/80'}`
    }, /*#__PURE__*/React.createElement("input", {
      type: "text",
      value: tabData.draftInput || '',
      onChange: e => setInAppBrowserTabs(prev => ({
        ...prev,
        [currentWebBot.id]: {
          ...tabData,
          draftInput: e.target.value
        }
      })),
      onKeyDown: e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleManualWebSend();
        }
      },
      placeholder: `向 ${currentWebBot.name} 提问…`,
      className: `flex-1 px-3 py-2 rounded-xl border text-xs focus:outline-none ${darkMode ? 'bg-zinc-900 border-white/15 text-white' : 'bg-white border-zinc-300 text-zinc-900'}`
    }), /*#__PURE__*/React.createElement("button", {
      type: "button",
      onClick: handleManualWebSend,
      className: "px-3.5 py-2 rounded-xl bg-[#007AFF] hover:bg-blue-600 text-white text-xs font-semibold flex items-center gap-1 shrink-0"
    }, /*#__PURE__*/React.createElement(Send, {
      className: "w-3.5 h-3.5"
    }), /*#__PURE__*/React.createElement("span", null, "\u53D1\u9001")))));
  };
  const glowHex = getIslandGlowColorHex();
  const breathScale = (1 + islandBreathLevel / 100 * 0.065).toFixed(4);
  const shadowMin = islandGlowEnabled ? `0 6px 22px -2px ${glowHex}66, 0 0 10px 0px ${glowHex}33` : '0 8px 25px -4px rgba(0,0,0,0.32)';
  const shadowMax = islandGlowEnabled ? `0 10px 36px 5px ${glowHex}bb, 0 0 24px 6px ${glowHex}77` : '0 12px 30px -2px rgba(0,0,0,0.42)';
  const avatarPx = Math.max(16, Math.min(24, Math.round(Math.min(islandHeight, 44) * 0.48)));
  const titleFontPx = Math.max(11, Math.min(15, Math.round(Math.min(islandHeight, 44) * 0.32)));
  const isTallCameraWrapIsland = islandHeight > 44 || islandGradientMode === 'advanced';
  const standalonePageTitle = activeTab === 'groups' ? 'Chat H' : activeTab === 'settings' || activeTab === 'bridge' ? '外观工坊' : activeTab === 'sync' || activeTab === 'anti-preach' ? '绑定与人设' : activeTab === 'webview' ? '内嵌网页' : null;
  const currentPinnedIds = activeGroupState.pinnedMessageIds || [];
  const currentMarkedIds = activeGroupState.markedMessageIds || [];
  const executeChatBatchAction = actionType => {
    setChatTopMenuOpen(false);
    if (actionType === 'search') {
      setChatSearchModalOpen(true);
      return;
    }
    if (actionType === 'view') {
      setPinsMarksModalOpen(true);
      return;
    }
    if (selectedMsgIds.length === 0) {
      setMsgSelectMode(actionType);
      const labelMap = {
        delete: '删除',
        forward: '转发',
        pin: '置顶（将向群内AI完整推送一次）',
        mark: '标记（个人备忘·点击可定位）',
        quote: '引用',
        copy: '复制'
      };
      showToast(`请点击勾选要${labelMap[actionType] || '操作'}的消息（支持单选或多选）`);
      return;
    }
    const chosenMsgs = messages.filter(m => selectedMsgIds.includes(m.id));
    if (actionType === 'delete') {
      const idsToDelete = new Set(selectedMsgIds);
      const nextMsgs = messages.filter(m => !idsToDelete.has(m.id));
      updateGroupMessages(nextMsgs, activeGroupId);
      updateGroupState(activeGroupId, state => ({
        ...state,
        pinnedMessageIds: (state.pinnedMessageIds || []).filter(id => !idsToDelete.has(id)),
        markedMessageIds: (state.markedMessageIds || []).filter(id => !idsToDelete.has(id))
      }));
      setSelectedMsgIds([]);
      setMsgSelectMode(null);
      showToast(`已删除选中的 ${chosenMsgs.length} 条消息`);
    } else if (actionType === 'forward') {
      setForwardModalOpen(true);
    } else if (actionType === 'pin') {
      const nextPinned = Array.from(new Set([...(activeGroupState.pinnedMessageIds || []), ...selectedMsgIds]));
      setSelectedMsgIds([]);
      setMsgSelectMode(null);
      notifyBotsOfPinnedMessagesOnce(activeGroupId, nextPinned);
    } else if (actionType === 'mark') {
      const nextMarked = Array.from(new Set([...(activeGroupState.markedMessageIds || []), ...selectedMsgIds]));
      updateGroupState(activeGroupId, state => ({
        ...state,
        markedMessageIds: nextMarked
      }));
      setSelectedMsgIds([]);
      setMsgSelectMode(null);
      showToast(`🔖 已标记 ${chosenMsgs.length} 条消息（可在右上角「查看」中随时点击定位回看，不发送给AI）`);
    } else if (actionType === 'quote') {
      if (chosenMsgs.length === 1) {
        beginQuote(chosenMsgs[0]);
      } else {
        setPendingQuote({
          id: chosenMsgs[chosenMsgs.length - 1].id,
          senderId: chosenMsgs[chosenMsgs.length - 1].senderId,
          groupId: activeGroupId,
          senderName: `${chosenMsgs.length}条消息汇总`,
          text: chosenMsgs.map(m => `[${m.senderName}]: ${m.text || ''}`).join(' ｜ ')
        });
      }
      setSelectedMsgIds([]);
      setMsgSelectMode(null);
      showToast(`已引用选中的 ${chosenMsgs.length} 条消息（引用优先级高于全部群聊接力模式）`);
    } else if (actionType === 'copy') {
      const textToCopy = chosenMsgs.map(m => `[${m.senderName} ${m.time}]: ${m.text || ''}`).join('\n');
      handleCopy(textToCopy, 'batch-copy');
      setSelectedMsgIds([]);
      setMsgSelectMode(null);
      showToast(`已复制选中的 ${chosenMsgs.length} 条消息`);
    }
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "h-screen w-screen overflow-hidden select-none flex flex-col",
    style: {
      fontFamily: getAppFontFamilyCss(),
      fontSize: `${appFontSize}px`
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: `relative flex flex-col w-full h-full overflow-hidden ${currentTheme.appBg}`,
    style: {
      background: themeColorMode === 'gradient' ? currentTheme.gradientBg || currentTheme.basicBg : currentTheme.basicBg || undefined,
      color: themeColorMode === 'gradient' && currentTheme.category === 'dopamine' ? '#ffffff' : undefined
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "pointer-events-none absolute inset-0 overflow-hidden z-0"
  }, /*#__PURE__*/React.createElement("div", {
    className: `absolute -top-32 -left-32 w-96 h-96 rounded-full blur-3xl transition-all duration-700 ${currentTheme.blob1}`
  }), /*#__PURE__*/React.createElement("div", {
    className: `absolute top-1/4 right-1/4 w-[28rem] h-[28rem] rounded-full blur-3xl transition-all duration-700 ${currentTheme.blob2}`
  }), /*#__PURE__*/React.createElement("div", {
    className: `absolute -bottom-24 right-10 w-80 h-80 rounded-full blur-3xl transition-all duration-700 ${currentTheme.blob3}`
  })), /*#__PURE__*/React.createElement("div", {
    className: "relative z-10 flex flex-1 min-h-0 w-full h-full"
  }, /*#__PURE__*/React.createElement("main", {
    className: `relative z-10 flex-1 flex flex-col min-w-0 min-h-0 w-full h-full backdrop-blur-2xl overflow-hidden ${themeColorMode === 'gradient' ? 'bg-transparent' : currentTheme.mainBg}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "relative z-40 w-full flex items-center justify-center px-3 shrink-0",
    style: {
      paddingTop: `${islandTopOffset}px`,
      paddingBottom: '6px'
    }
  }, standalonePageTitle && !islandExpanded && /*#__PURE__*/React.createElement("div", {
    className: `absolute left-3.5 flex items-center gap-1.5 px-3 py-1 rounded-2xl backdrop-blur-2xl border shadow-[0_4px_16px_rgba(0,0,0,0.08),inset_0_1px_1px_rgba(255,255,255,0.85)] transition-all ${darkMode ? 'bg-zinc-900/55 border-white/20 text-white' : 'bg-white/60 border-white/85 text-zinc-900'}`,
    style: {
      top: `${islandTopOffset + Math.max(0, Math.round((islandHeight - 28) / 2))}px`
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-xs font-extrabold tracking-tight"
  }, standalonePageTitle)), /*#__PURE__*/React.createElement("div", {
    className: "pointer-events-auto flex flex-col items-center justify-center"
  }, /*#__PURE__*/React.createElement("div", {
    onClick: () => {
      if (!islandExpanded) setIslandExpanded(true);
    },
    className: `backdrop-blur-2xl border overflow-hidden relative ${activeIslandStyle.bgClass} ${!islandExpanded && islandBreathLevel > 0 ? 'webh-island-breathing' : ''}`,
    style: {
      ...getIslandInlineStyle(),
      width: islandExpanded ? 'min(94vw, 420px)' : islandEvent || typingBots.length > 0 ? `${Math.min(360, islandWidth + 44)}px` : `${islandWidth}px`,
      minHeight: islandExpanded ? '260px' : `${islandHeight}px`,
      maxHeight: islandExpanded ? '540px' : `${islandHeight}px`,
      borderRadius: islandExpanded ? '28px' : `${Math.ceil(islandHeight / 2) + 8}px`,
      padding: islandExpanded ? '14px' : '0px 14px',
      transition: 'width 520ms cubic-bezier(0.32, 0.72, 0, 1), min-height 520ms cubic-bezier(0.32, 0.72, 0, 1), max-height 520ms cubic-bezier(0.32, 0.72, 0, 1), border-radius 520ms cubic-bezier(0.32, 0.72, 0, 1), padding 520ms cubic-bezier(0.32, 0.72, 0, 1), box-shadow 520ms cubic-bezier(0.32, 0.72, 0, 1), transform 520ms cubic-bezier(0.32, 0.72, 0, 1)',
      '--island-breath-scale': breathScale,
      '--island-shadow-min': shadowMin,
      '--island-shadow-max': shadowMax,
      boxShadow: shadowMin
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      height: islandExpanded ? '0px' : `${islandHeight}px`,
      opacity: islandExpanded ? 0 : 1,
      transform: islandExpanded ? 'scale(0.92)' : 'scale(1)',
      pointerEvents: islandExpanded ? 'none' : 'auto',
      paddingBottom: !islandExpanded && isTallCameraWrapIsland ? '7px' : '0px',
      transition: 'opacity 260ms ease, transform 380ms cubic-bezier(0.32, 0.72, 0, 1)'
    },
    className: `w-full flex ${isTallCameraWrapIsland ? 'items-end' : 'items-center'} justify-between gap-2 overflow-hidden`
  }, !(islandEvent || typingBots.length > 0) ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center -space-x-1.5 shrink-0"
  }, activeBots.slice(0, 4).map(b => /*#__PURE__*/React.createElement("div", {
    key: b.id,
    className: "ring-1 ring-black/40 rounded-full flex items-center justify-center overflow-hidden",
    style: {
      width: `${avatarPx}px`,
      height: `${avatarPx}px`
    }
  }, renderEntityAvatar(b, 'w-full h-full', 'text-[8px]', true)))), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-1 truncate min-w-0"
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: `${titleFontPx}px`
    },
    className: `font-semibold tracking-tight truncate ${isIslandLight ? 'text-zinc-900' : 'text-zinc-100'}`
  }, activeGroup?.name || 'Chat H'), /*#__PURE__*/React.createElement("span", {
    className: `text-[10px] opacity-80 shrink-0 ${isIslandLight ? 'text-zinc-600' : 'text-zinc-300'}`
  }, "\xB7 ", activeAutoPilot.enabled ? `🔥值守${activeAutoPilot.remainingRounds}轮` : dispatchMode === 'smart-chain' ? `接力·${chatSubMode === 'speed' ? '速度' : chatSubMode === 'random' ? '随机' : '专业'}` : activeModeLabel)), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-1 shrink-0"
  }, /*#__PURE__*/React.createElement("span", {
    className: "w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_10px_#34d399] animate-pulse"
  }), /*#__PURE__*/React.createElement(ChevronDown, {
    className: `w-3.5 h-3.5 ${isIslandLight ? 'text-zinc-600' : 'text-zinc-300'}`
  }))) : /*#__PURE__*/React.createElement("div", {
    className: "w-full flex items-center justify-between gap-2.5"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2 min-w-0"
  }, /*#__PURE__*/React.createElement("div", {
    className: `w-6 h-6 rounded-full bg-gradient-to-br ${islandEvent?.avatarBg || 'from-blue-500 to-indigo-600'} text-white text-[9px] font-bold flex items-center justify-center shrink-0 animate-pulse`
  }, islandEvent?.badgeText || 'AI'), /*#__PURE__*/React.createElement("div", {
    className: "min-w-0"
  }, /*#__PURE__*/React.createElement("div", {
    className: `text-xs font-semibold truncate ${isIslandLight ? 'text-zinc-900' : 'text-white'}`
  }, islandEvent ? islandEvent.title : `${typingBots.map(id => bots.find(b => b.id === id)?.name).join('、')} 思考中...`), /*#__PURE__*/React.createElement("div", {
    className: `text-[10px] truncate ${isIslandLight ? 'text-zinc-500' : 'text-zinc-300'}`
  }, islandEvent ? islandEvent.subtitle : '实时流式同步中'))), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-0.5 shrink-0"
  }, /*#__PURE__*/React.createElement("span", {
    className: "w-1 h-2.5 rounded-full bg-emerald-400 animate-pulse"
  }), /*#__PURE__*/React.createElement("span", {
    className: "w-1 h-4 rounded-full bg-blue-400 animate-pulse"
  }), /*#__PURE__*/React.createElement("span", {
    className: "w-1 h-3 rounded-full bg-purple-400 animate-pulse"
  })))), /*#__PURE__*/React.createElement("div", {
    style: {
      opacity: islandExpanded ? 1 : 0,
      transform: islandExpanded ? 'translateY(0) scale(1)' : 'translateY(-8px) scale(0.95)',
      pointerEvents: islandExpanded ? 'auto' : 'none',
      maxHeight: islandExpanded ? '510px' : '0px',
      transition: 'opacity 340ms ease 60ms, transform 440ms cubic-bezier(0.32, 0.72, 0, 1)'
    },
    className: "space-y-2.5 text-xs overflow-y-auto no-scrollbar"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-between px-1"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2"
  }, /*#__PURE__*/React.createElement("span", {
    className: "w-2 h-2 rounded-full bg-emerald-400 animate-ping"
  }), /*#__PURE__*/React.createElement("span", {
    className: `text-[11px] font-bold ${isIslandLight ? 'text-zinc-800' : 'text-zinc-100'}`
  }, "Chat H \u7075\u52A8\u5C9B \xB7 ", activeGroup?.name)), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: e => {
      e.stopPropagation();
      setIslandExpanded(false);
    },
    className: `p-1 rounded-full ${isIslandLight ? 'bg-black/10 text-zinc-700' : 'bg-white/10 text-zinc-200'}`
  }, /*#__PURE__*/React.createElement(X, {
    className: "w-3.5 h-3.5"
  }))), /*#__PURE__*/React.createElement("div", {
    className: `p-1 rounded-2xl grid grid-cols-5 gap-1 border ${isIslandLight ? 'bg-black/[0.05] border-black/[0.06]' : 'bg-white/[0.07] border-white/[0.08]'}`
  }, [{
    id: 'groups',
    label: '群与游标',
    icon: Layers
  }, {
    id: 'chat',
    label: '群聊',
    icon: MessageSquare
  }, {
    id: 'webview',
    label: '内嵌网页',
    icon: Globe
  }, {
    id: 'sync',
    label: '绑定/人设',
    icon: Link2
  }, {
    id: 'settings',
    label: '外观工坊',
    icon: Palette
  }].map(item => {
    const Icon = item.icon;
    const isActive = activeTab === item.id;
    return /*#__PURE__*/React.createElement("button", {
      key: item.id,
      type: "button",
      onClick: e => {
        e.stopPropagation();
        setActiveTab(item.id);
        setIslandExpanded(false);
      },
      className: `py-1.5 px-1.5 rounded-xl text-[10px] font-medium transition-all flex flex-col items-center justify-center gap-1 ${isActive ? isIslandLight ? 'bg-zinc-900 text-white shadow-sm font-semibold' : 'bg-white text-zinc-950 shadow-sm font-semibold' : isIslandLight ? 'text-zinc-600 hover:bg-black/5' : 'text-zinc-300 hover:bg-white/10'}`
    }, /*#__PURE__*/React.createElement(Icon, {
      className: "w-3.5 h-3.5 shrink-0"
    }), /*#__PURE__*/React.createElement("span", {
      className: "truncate"
    }, item.label));
  })), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-between gap-1.5"
  }, /*#__PURE__*/React.createElement("div", {
    className: `flex items-center gap-1 p-1 rounded-2xl border flex-1 justify-around ${isIslandLight ? 'bg-black/[0.05] border-black/[0.06]' : 'bg-white/[0.06] border-white/[0.08]'}`
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: e => {
      e.stopPropagation();
      setDispatchMode('smart-chain');
      setIslandPanel(null);
      setIslandGroupMenuOpen(prev => !prev);
    },
    className: `px-2.5 py-1 rounded-xl text-[11px] font-semibold transition-all duration-300 ${dispatchMode === 'smart-chain' && islandPanel !== 'duty' ? 'bg-[#007AFF] text-white shadow-xs' : isIslandLight ? 'text-zinc-600 hover:bg-black/5' : 'text-zinc-300 hover:bg-white/10'}`
  }, "\u7FA4\u804A\u63A5\u529B"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: e => {
      e.stopPropagation();
      setDispatchMode('co-answer');
      setIslandGroupMenuOpen(false);
      setIslandPanel(null);
    },
    className: `px-2.5 py-1 rounded-xl text-[11px] font-semibold transition-all duration-300 ${dispatchMode === 'co-answer' && islandPanel !== 'duty' ? 'bg-[#007AFF] text-white shadow-xs' : isIslandLight ? 'text-zinc-600 hover:bg-black/5' : 'text-zinc-300 hover:bg-white/10'}`
  }, "\u5168\u5458\u5171\u7B54"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: e => {
      e.stopPropagation();
      setDispatchMode('mention-only');
      setIslandGroupMenuOpen(false);
      setIslandPanel(null);
    },
    className: `px-2.5 py-1 rounded-xl text-[11px] font-semibold transition-all duration-300 ${dispatchMode === 'mention-only' && islandPanel !== 'duty' ? 'bg-[#007AFF] text-white shadow-xs' : isIslandLight ? 'text-zinc-600 hover:bg-black/5' : 'text-zinc-300 hover:bg-white/10'}`
  }, "\u70B9\u540D\u56DE\u7B54"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: e => {
      e.stopPropagation();
      setIslandGroupMenuOpen(false);
      setIslandPanel(cur => cur === 'duty' ? null : 'duty');
    },
    className: `px-2.5 py-1 rounded-xl text-[11px] font-semibold transition-all duration-300 ${islandPanel === 'duty' || activeAutoPilot.enabled ? 'bg-orange-500 text-white shadow-xs' : isIslandLight ? 'text-zinc-600 hover:bg-black/5' : 'text-zinc-300 hover:bg-white/10'}`
  }, activeAutoPilot.enabled ? `无人值守(${activeAutoPilot.remainingRounds})` : '无人值守')), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: e => {
      e.stopPropagation();
      handleEmergencyReset();
      setIslandExpanded(false);
    },
    className: "px-2.5 py-1.5 rounded-xl bg-rose-500/20 text-rose-300 border border-rose-500/30 text-[10px] font-semibold shrink-0"
  }, "\u91CD\u7F6E")), /*#__PURE__*/React.createElement("div", {
    onClick: e => e.stopPropagation(),
    style: {
      maxHeight: islandGroupMenuOpen || dispatchMode === 'smart-chain' && islandPanel !== 'duty' ? '56px' : '0px',
      opacity: islandGroupMenuOpen || dispatchMode === 'smart-chain' && islandPanel !== 'duty' ? 1 : 0,
      transform: islandGroupMenuOpen || dispatchMode === 'smart-chain' && islandPanel !== 'duty' ? 'translateY(0) scale(1)' : 'translateY(-6px) scale(0.96)',
      pointerEvents: islandGroupMenuOpen || dispatchMode === 'smart-chain' && islandPanel !== 'duty' ? 'auto' : 'none',
      transition: 'max-height 460ms cubic-bezier(0.32, 0.72, 0, 1), opacity 320ms ease, transform 440ms cubic-bezier(0.32, 0.72, 0, 1)'
    },
    className: "overflow-hidden"
  }, /*#__PURE__*/React.createElement("div", {
    className: `px-2.5 py-2 rounded-2xl border flex items-center justify-between gap-2 ${isIslandLight ? 'bg-white/80 border-black/10 text-zinc-800' : 'bg-white/[0.08] border-white/15 text-zinc-100'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-1"
  }, [{
    id: 'speed',
    label: '速度'
  }, {
    id: 'random',
    label: '随机'
  }, {
    id: 'smart',
    label: '智能'
  }].map(sub => /*#__PURE__*/React.createElement("button", {
    key: sub.id,
    type: "button",
    onClick: e => {
      e.stopPropagation();
      setDispatchMode('smart-chain');
      setChatSubMode(sub.id);
    },
    className: `px-3 py-1 rounded-xl text-[11px] font-bold transition-all duration-300 ${chatSubMode === sub.id ? 'bg-[#007AFF] text-white shadow-xs' : isIslandLight ? 'bg-black/5 text-zinc-700 hover:bg-black/10' : 'bg-white/10 text-zinc-300 hover:bg-white/15'}`
  }, sub.label))), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-1 text-[11px]"
  }, /*#__PURE__*/React.createElement("span", {
    className: "opacity-70 text-[10px]"
  }, "\u4EBA\u6570"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => setChatBotLimit(prev => Math.max(1, (prev === 0 ? activeBots.length : prev) - 1)),
    className: "w-5 h-5 rounded-lg bg-white/10 flex items-center justify-center font-bold"
  }, "-"), /*#__PURE__*/React.createElement("span", {
    className: "font-mono font-bold text-blue-400 min-w-[20px] text-center"
  }, chatBotLimit === 0 ? activeBots.length : chatBotLimit), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => setChatBotLimit(prev => Math.min(activeBots.length, (prev === 0 ? activeBots.length : prev) + 1)),
    className: "w-5 h-5 rounded-lg bg-white/10 flex items-center justify-center font-bold"
  }, "+"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => setChatBotLimit(0),
    className: `px-2 py-0.5 rounded-lg text-[10px] font-semibold transition-all ${chatBotLimit === 0 ? 'bg-emerald-500 text-white' : 'bg-white/10 text-zinc-300'}`
  }, "\u5168\u90E8")))), /*#__PURE__*/React.createElement("div", {
    onClick: e => e.stopPropagation(),
    style: {
      maxHeight: islandPanel === 'duty' ? '56px' : '0px',
      opacity: islandPanel === 'duty' ? 1 : 0,
      transform: islandPanel === 'duty' ? 'translateY(0) scale(1)' : 'translateY(-6px) scale(0.96)',
      pointerEvents: islandPanel === 'duty' ? 'auto' : 'none',
      transition: 'max-height 460ms cubic-bezier(0.32, 0.72, 0, 1), opacity 320ms ease, transform 440ms cubic-bezier(0.32, 0.72, 0, 1)'
    },
    className: "overflow-hidden"
  }, /*#__PURE__*/React.createElement("div", {
    className: `px-2.5 py-2 rounded-2xl border flex items-center justify-between gap-2 ${isIslandLight ? 'bg-white/85 border-black/10 text-zinc-800' : 'bg-white/[0.08] border-white/15 text-zinc-100'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-1"
  }, [4, 8, 12, 20].map(r => /*#__PURE__*/React.createElement("button", {
    key: r,
    type: "button",
    onClick: () => setAutoPilotRoundsDraft(r),
    className: `px-2 py-1 rounded-lg text-[10px] font-bold transition-all ${autoPilotRoundsDraft === r ? 'bg-orange-500 text-white' : 'bg-white/10 text-zinc-300'}`
  }, r, "\u8F6E")), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => setAutoPilotRoundsDraft(v => Math.max(1, v - 1)),
    className: "w-5 h-5 rounded-lg bg-white/10 flex items-center justify-center font-bold"
  }, "-"), /*#__PURE__*/React.createElement("span", {
    className: "font-mono font-bold text-orange-400 min-w-[30px] text-center text-[11px]"
  }, autoPilotRoundsDraft, "\u8F6E"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => setAutoPilotRoundsDraft(v => Math.min(100, v + 1)),
    className: "w-5 h-5 rounded-lg bg-white/10 flex items-center justify-center font-bold"
  }, "+")), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-1 shrink-0"
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => activeAutoPilot.enabled ? stopAutoPilot(activeGroupId) : startAutoPilot(activeGroupId, autoPilotRoundsDraft),
    className: `px-3 py-1 rounded-xl font-bold text-[11px] transition-all ${activeAutoPilot.enabled ? 'bg-rose-500 text-white' : 'bg-orange-500 text-white'}`
  }, activeAutoPilot.enabled ? '停止' : '开启'), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => {
      setIslandExpanded(false);
      requestConclusionCard(activeGroupId);
    },
    className: "px-2.5 py-1 rounded-xl font-bold text-[11px] bg-emerald-500/20 border border-emerald-400/35 text-emerald-300"
  }, "\u7ED3\u8BBA"))))))), activeTab === 'chat' && !islandExpanded && /*#__PURE__*/React.createElement("div", {
    className: "absolute right-3.5 flex items-center justify-center",
    style: {
      top: `${islandTopOffset}px`
    }
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => setChatTopMenuOpen(v => !v),
    style: {
      width: `${topActionBtnSize}px`,
      height: `${topActionBtnSize}px`
    },
    title: "\u6D88\u606F\u64CD\u4F5C\u83DC\u5355\uFF08\u641C\u7D22 / \u67E5\u770B / \u6807\u8BB0 / \u7F6E\u9876 / \u5F15\u7528 / \u8F6C\u53D1 / \u590D\u5236 / \u5220\u9664\uFF09",
    className: `rounded-full backdrop-blur-2xl border shadow-[0_8px_30px_rgba(0,0,0,0.18)] flex items-center justify-center transition-all active:scale-90 ${chatTopMenuOpen || msgSelectMode ? 'bg-[#007AFF] text-white border-blue-400 ring-2 ring-blue-400/30' : darkMode ? 'bg-zinc-900/65 border-white/20 text-white hover:bg-zinc-800/80' : 'bg-white/70 border-white/80 text-zinc-800 hover:bg-white/90'}`
  }, selectedMsgIds.length > 0 ? /*#__PURE__*/React.createElement("span", {
    className: "text-xs font-extrabold font-mono"
  }, selectedMsgIds.length) : /*#__PURE__*/React.createElement(Sliders, {
    className: "w-4 h-4"
  })), chatTopMenuOpen && /*#__PURE__*/React.createElement("div", {
    className: `absolute right-0 top-full mt-2 w-52 p-2 rounded-3xl backdrop-blur-3xl border shadow-2xl z-50 space-y-1 ${darkMode ? 'bg-zinc-900/95 border-white/15 text-zinc-100' : 'bg-white/95 border-white/85 text-zinc-800'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "px-2.5 py-1 text-[10px] font-semibold opacity-55 border-b border-current/10 flex items-center justify-between"
  }, /*#__PURE__*/React.createElement("span", null, "Chat H \u6D88\u606F\u64CD\u4F5C\u53F0"), /*#__PURE__*/React.createElement("span", null, selectedMsgIds.length > 0 ? `已选 ${selectedMsgIds.length} 条` : '支持单选/多选')), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-2 gap-1.5 pt-1 pb-1 border-b border-current/10"
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => executeChatBatchAction('search'),
    className: `p-2 rounded-2xl border text-left transition-all ${darkMode ? 'bg-white/5 hover:bg-white/10 border-white/10' : 'bg-blue-50/70 hover:bg-blue-100/70 border-blue-200/60'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-1.5 text-xs font-bold text-[#007AFF]"
  }, /*#__PURE__*/React.createElement(Search, {
    className: "w-3.5 h-3.5"
  }), /*#__PURE__*/React.createElement("span", null, "\u641C\u7D22")), /*#__PURE__*/React.createElement("div", {
    className: "text-[9px] opacity-65 mt-0.5"
  }, "\u5173\u952E\u8BCD/\u6309\u65E5\u671F\u7B5B\u9009")), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => executeChatBatchAction('view'),
    className: `p-2 rounded-2xl border text-left transition-all ${darkMode ? 'bg-white/5 hover:bg-white/10 border-white/10' : 'bg-amber-50/80 hover:bg-amber-100/70 border-amber-200/70'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-1.5 text-xs font-bold text-amber-500"
  }, /*#__PURE__*/React.createElement(Eye, {
    className: "w-3.5 h-3.5"
  }), /*#__PURE__*/React.createElement("span", null, "\u67E5\u770B")), /*#__PURE__*/React.createElement("div", {
    className: "text-[9px] opacity-70 mt-0.5"
  }, "\u7F6E\u9876", currentPinnedIds.length, " \xB7 \u6807\u8BB0", currentMarkedIds.length))), [{
    id: 'mark',
    label: '标记消息 (个人备忘)',
    icon: CheckCircle2,
    color: 'text-purple-500'
  }, {
    id: 'pin',
    label: '置顶消息 (全员AI可见)',
    icon: Pin,
    color: 'text-amber-500'
  }, {
    id: 'quote',
    label: '引用回复 (最高优先)',
    icon: Quote,
    color: 'text-emerald-500'
  }, {
    id: 'forward',
    label: '跨群转发 (带AI来源)',
    icon: CornerUpRight,
    color: 'text-blue-500'
  }, {
    id: 'copy',
    label: '复制内容',
    icon: Copy,
    color: 'text-indigo-500'
  }, {
    id: 'delete',
    label: '删除消息',
    icon: Trash2,
    color: 'text-rose-500'
  }].map(act => {
    const ActIcon = act.icon;
    return /*#__PURE__*/React.createElement("button", {
      key: act.id,
      type: "button",
      onClick: () => executeChatBatchAction(act.id),
      className: `w-full px-3 py-2 rounded-2xl text-xs font-semibold flex items-center justify-between transition-all ${darkMode ? 'hover:bg-white/10 active:bg-white/15' : 'hover:bg-black/5 active:bg-black/10'}`
    }, /*#__PURE__*/React.createElement("span", {
      className: "flex items-center gap-2"
    }, /*#__PURE__*/React.createElement(ActIcon, {
      className: `w-3.5 h-3.5 ${act.color}`
    }), /*#__PURE__*/React.createElement("span", null, act.label)), /*#__PURE__*/React.createElement(ChevronRight, {
      className: "w-3 h-3 opacity-40"
    }));
  }), (msgSelectMode || selectedMsgIds.length > 0) && /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => {
      setMsgSelectMode(null);
      setSelectedMsgIds([]);
      setChatTopMenuOpen(false);
    },
    className: "w-full px-3 py-1.5 rounded-2xl text-[11px] font-medium text-center opacity-70 hover:opacity-100 border-t border-current/10"
  }, "\u53D6\u6D88\u52FE\u9009\u6A21\u5F0F")))), !isMinimizedToIsland && activeTab === 'webview' && /*#__PURE__*/React.createElement("div", {
    onClick: () => islandExpanded && setIslandExpanded(false),
    className: "flex-1 flex flex-col min-h-0 relative overflow-hidden"
  }, renderInAppBrowserContainer(false)), !isMinimizedToIsland && (activeTab === 'chat' || activeTab === 'groups') && /*#__PURE__*/React.createElement("div", {
    className: "flex-1 flex flex-col min-h-0 relative"
  }, activeTab === 'groups' && /*#__PURE__*/React.createElement("div", {
    onClick: () => islandExpanded && setIslandExpanded(false),
    style: {
      background: groupsBgMode !== 'recent-chat' ? getWallpaperCssForMode(groupsBgMode, groupsCustomBgUrl) || undefined : undefined
    },
    className: `absolute inset-0 z-30 overflow-y-auto px-4 pb-6 pt-2.5 space-y-4 transition-all duration-300 ${groupsBgMode === 'recent-chat' ? darkMode ? 'bg-black/22 backdrop-blur-[4px]' : 'bg-slate-900/12 backdrop-blur-[4px]' : 'text-white'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "relative z-10 flex items-center gap-2"
  }, /*#__PURE__*/React.createElement("div", {
    style: getAppleLiquidGlassCardStyle(0.04),
    className: "flex-1 flex items-center gap-2 px-3.5 py-2.5 rounded-2xl border"
  }, /*#__PURE__*/React.createElement(Search, {
    className: "w-4 h-4 opacity-75 shrink-0"
  }), /*#__PURE__*/React.createElement("input", {
    type: "text",
    value: sidebarSearchQuery,
    onChange: e => setSidebarSearchQuery(e.target.value),
    placeholder: "\u641C\u7D22\u7FA4\u804A\u7A7A\u95F4\u3001AI \u89D2\u8272\u6216\u6E38\u6807\u72B6\u6001\u2026",
    className: "w-full bg-transparent text-xs font-medium focus:outline-none placeholder:opacity-75"
  })), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: startNewGroup,
    style: getAppleLiquidGlassCardStyle(0.12),
    className: "px-3.5 py-2.5 rounded-2xl border text-xs font-bold flex items-center gap-1 shrink-0"
  }, /*#__PURE__*/React.createElement(Plus, {
    className: "w-4 h-4 text-[#007AFF]"
  }), /*#__PURE__*/React.createElement("span", null, "\u65B0\u5EFA\u7FA4\u804A"))), /*#__PURE__*/React.createElement("div", {
    className: "relative z-10 space-y-2.5"
  }, /*#__PURE__*/React.createElement("div", {
    className: "px-1 flex items-center justify-between"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-xs font-extrabold tracking-tight drop-shadow-xs"
  }, "\u591A\u6A21\u578B\u7FA4\u804A\u7A7A\u95F4\uFF08\u70B9\u51FB\u8FDB\u5165\u7FA4\u804A\uFF09"), /*#__PURE__*/React.createElement("span", {
    className: "text-[11px] font-bold opacity-85 drop-shadow-xs"
  }, "\u5171 ", groups.length, " \u4E2A\u7FA4\u804A \xB7 \u6DB2\u6001\u73BB\u7483")), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-1 gap-2.5"
  }, groups.filter(g => {
    const q = sidebarSearchQuery.trim().toLowerCase();
    if (!q) return true;
    return g.name.toLowerCase().includes(q) || (g.subtitle || '').toLowerCase().includes(q);
  }).map(g => {
    const gMsgs = groupMessages[g.id] || [];
    const lastMsg = gMsgs[gMsgs.length - 1];
    const isCurrent = g.id === activeGroupId;
    return /*#__PURE__*/React.createElement("div", {
      key: g.id,
      onClick: () => {
        setActiveGroupId(g.id);
        setActiveTab('chat');
      },
      style: getAppleLiquidGlassCardStyle(isCurrent ? 0.08 : 0),
      className: `p-4 rounded-[28px] border transition-all cursor-pointer flex items-center gap-3.5 ${isCurrent ? 'ring-1 ring-white/80' : ''}`
    }, /*#__PURE__*/React.createElement("div", {
      className: "w-12 h-12 rounded-2xl p-1.5 grid grid-cols-2 gap-1 bg-white/25 dark:bg-black/25 backdrop-blur-md border border-white/60 shrink-0 shadow-inner"
    }, bots.filter(bot => g.memberIds?.includes(bot.id)).slice(0, 4).map(b => /*#__PURE__*/React.createElement("div", {
      key: b.id,
      className: "flex items-center justify-center"
    }, renderEntityAvatar(b, 'w-4 h-4', 'text-[7px]', true)))), /*#__PURE__*/React.createElement("div", {
      className: "flex-1 min-w-0"
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex items-center justify-between gap-2"
    }, /*#__PURE__*/React.createElement("span", {
      className: "text-sm font-extrabold truncate drop-shadow-2xs"
    }, g.name), /*#__PURE__*/React.createElement("span", {
      className: "text-[11px] font-semibold opacity-80 shrink-0"
    }, g.time || '刚刚')), /*#__PURE__*/React.createElement("p", {
      className: "text-xs opacity-85 truncate mt-1 font-medium drop-shadow-2xs"
    }, lastMsg ? `${lastMsg.senderName?.split(' ')[0]}: ${lastMsg.text || '媒体/文件消息'}` : `${(g.memberIds || []).length} 位 AI 成员 · ${g.subtitle || '点击开始群聊'}`)), /*#__PURE__*/React.createElement("button", {
      type: "button",
      onClick: e => {
        e.stopPropagation();
        startEditGroup(g);
      },
      style: getAppleLiquidGlassCardStyle(0.06),
      className: "p-2.5 rounded-2xl border",
      title: "\u7F16\u8F91\u7FA4\u6210\u5458\u4E0E\u540D\u79F0"
    }, /*#__PURE__*/React.createElement(Sliders, {
      className: "w-4 h-4"
    })));
  }))), /*#__PURE__*/React.createElement("div", {
    className: "relative z-10 space-y-2.5 pt-1"
  }, /*#__PURE__*/React.createElement("div", {
    className: "px-1 flex items-center justify-between"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-xs font-extrabold tracking-tight drop-shadow-xs"
  }, "AI \u589E\u91CF\u6E38\u6807\u72B6\u6001 \xB7 \u7ED1\u5B9A\u7F51\u9875\u76D1\u63A7"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: startNewBot,
    className: "text-xs text-[#007AFF] font-extrabold flex items-center gap-0.5 bg-white/70 dark:bg-black/50 px-2.5 py-1 rounded-full backdrop-blur-md"
  }, /*#__PURE__*/React.createElement(Plus, {
    className: "w-3.5 h-3.5"
  }), /*#__PURE__*/React.createElement("span", null, "\u6DFB\u52A0 AI"))), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-1 sm:grid-cols-2 gap-2.5"
  }, bots.map(bot => {
    const cursorVal = getCursorForBot(bot.id, activeGroupId);
    const unreadCount = activeGroup?.memberIds?.includes(bot.id) ? getUnreadMessagesForBot(bot.id).length : 0;
    return /*#__PURE__*/React.createElement("div", {
      key: bot.id,
      style: getAppleLiquidGlassCardStyle(0.02),
      className: "p-3.5 rounded-[28px] border flex flex-col gap-2.5"
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex items-center justify-between gap-2"
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex items-center gap-2.5 min-w-0"
    }, renderEntityAvatar(bot, 'w-9 h-9', 'text-xs'), /*#__PURE__*/React.createElement("div", {
      className: "min-w-0"
    }, /*#__PURE__*/React.createElement("div", {
      className: "text-xs font-extrabold truncate flex items-center gap-1.5 drop-shadow-2xs"
    }, /*#__PURE__*/React.createElement("span", null, bot.name), bot.roleTag && /*#__PURE__*/React.createElement("span", {
      className: "text-[10px] px-2 py-0.5 rounded-full bg-white/35 dark:bg-black/35 border border-white/40 font-semibold truncate"
    }, bot.roleTag)), /*#__PURE__*/React.createElement("div", {
      className: "text-[10px] opacity-80 font-mono truncate mt-0.5"
    }, "\u7ED1\u5B9A\u7F51\u5740: ", bot.targetUrl ? bot.targetUrl.replace('https://', '') : '未绑定'))), /*#__PURE__*/React.createElement("span", {
      className: `px-2.5 py-1 rounded-full text-[10px] font-bold shrink-0 backdrop-blur-md ${unreadCount === 0 ? 'bg-emerald-500/25 text-emerald-950 dark:text-emerald-200 border border-emerald-400/50' : 'bg-amber-500/25 text-amber-950 dark:text-amber-200 border border-amber-400/50'}`
    }, unreadCount === 0 ? `游标 #${cursorVal} 已对齐` : `+${unreadCount} 条未读`)), /*#__PURE__*/React.createElement("div", {
      className: "flex items-center justify-between gap-2 pt-1.5 border-t border-white/30 dark:border-white/15 text-[11px]"
    }, /*#__PURE__*/React.createElement("button", {
      type: "button",
      onClick: () => {
        updateBotCursor(bot.id, activeGroupId, 0);
        showToast(`已重置 ${bot.name} 的同步游标`);
      },
      className: "px-2.5 py-1 rounded-xl bg-white/35 dark:bg-white/10 border border-white/60 font-semibold"
    }, "\u91CD\u7F6E\u6E38\u6807"), /*#__PURE__*/React.createElement("div", {
      className: "flex items-center gap-1.5"
    }, /*#__PURE__*/React.createElement("button", {
      type: "button",
      onClick: () => setPersonaEditorBotId(bot.id),
      className: "px-2.5 py-1 rounded-xl bg-white/35 dark:bg-white/10 border border-white/60 font-semibold"
    }, "\u4EBA\u8BBE\u7F16\u8F91"), /*#__PURE__*/React.createElement("button", {
      type: "button",
      onClick: () => {
        setEditingBot(bot);
        setActiveTab('sync');
      },
      className: "px-2.5 py-1 rounded-xl bg-[#007AFF] text-white font-semibold shadow-xs"
    }, "\u914D\u7F6E\u7F51\u5740"))));
  })))), (() => {
    const grpWp = groupWallpapers[activeGroupId] || {};
    const bgCss = getWallpaperCssForMode(grpWp.bgMode, grpWp.customUrl);
    const showDropletsInChat = grpWp.liquidEnabled !== false && liquidDropletType !== 'none' && Boolean(DROPLET_TEXTURES[liquidDropletType]);
    return /*#__PURE__*/React.createElement(React.Fragment, null, bgCss && /*#__PURE__*/React.createElement("div", {
      className: "pointer-events-none absolute inset-0 z-0 transition-all duration-500",
      style: {
        background: bgCss
      }
    }));
  })(), splitWebViewOpen && renderInAppBrowserContainer(true), /*#__PURE__*/React.createElement("div", {
    onClick: () => islandExpanded && setIslandExpanded(false),
    className: "flex-1 overflow-y-auto px-5 sm:px-10 py-4 space-y-6"
  }, (activeGroupState.circuitBrokenBots && Object.keys(activeGroupState.circuitBrokenBots).length > 0 || Number(featureSettings.maxSessionRounds) > 0 && (activeGroupState.sessionRounds || 0) >= Number(featureSettings.maxSessionRounds)) && /*#__PURE__*/React.createElement("div", {
    className: "space-y-2"
  }, activeGroupState.circuitBrokenBots && Object.keys(activeGroupState.circuitBrokenBots).length > 0 && /*#__PURE__*/React.createElement("div", {
    className: `p-3 rounded-2xl border flex flex-wrap items-center justify-between gap-2 text-xs ${darkMode ? 'bg-rose-950/60 border-rose-500/35 text-rose-200' : 'bg-rose-50 border-rose-200 text-rose-800'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2"
  }, /*#__PURE__*/React.createElement("span", {
    className: "px-2 py-0.5 rounded-full bg-rose-500 text-white text-[10px] font-bold"
  }, "\u9632\u5C01\u7194\u65AD\u4FDD\u62A4\u4E2D"), /*#__PURE__*/React.createElement("span", null, Object.keys(activeGroupState.circuitBrokenBots).map(id => bots.find(b => b.id === id)?.name || id).join('、'), ' ', "\u8FD4\u56DE\u4E86\u7591\u4F3C\u9650\u6D41/\u9A8C\u8BC1\u63D0\u793A\uFF0C\u5DF2\u6682\u505C\u81EA\u52A8\u8BF7\u6C42\u3002\u8BF7\u5207\u5230 Chrome \u68C0\u67E5\u7F51\u9875\u6062\u590D\u540E\u89E3\u9664\u3002")), /*#__PURE__*/React.createElement("button", {
    onClick: () => updateGroupState(activeGroupId, state => ({
      ...state,
      circuitBrokenBots: {}
    })),
    className: "px-2.5 py-1 rounded-xl bg-rose-500 hover:bg-rose-600 text-white text-[11px] font-semibold shrink-0"
  }, "\u5DF2\u4EBA\u5DE5\u68C0\u67E5\uFF0C\u89E3\u9664\u7194\u65AD")), Number(featureSettings.maxSessionRounds) > 0 && (activeGroupState.sessionRounds || 0) >= Number(featureSettings.maxSessionRounds) && /*#__PURE__*/React.createElement("div", {
    className: `p-3 rounded-2xl border flex flex-wrap items-center justify-between gap-2 text-xs ${darkMode ? 'bg-amber-950/60 border-amber-500/35 text-amber-200' : 'bg-amber-50 border-amber-200 text-amber-900'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2"
  }, /*#__PURE__*/React.createElement("span", {
    className: "px-2 py-0.5 rounded-full bg-amber-500 text-white text-[10px] font-bold"
  }, "\u5355\u8D34\u5DF2\u6EE1 ", activeGroupState.sessionRounds, "/", featureSettings.maxSessionRounds, " \u8F6E"), /*#__PURE__*/React.createElement("span", null, "\u4E3A\u907F\u514D\u8D85\u957F\u5355\u8D34\u89E6\u53D1\u5E73\u53F0 Token \u5BA1\u8BA1\uFF0C\u5EFA\u8BAE\u5148\u751F\u6210\u7ED3\u8BBA\u5361\uFF0C\u518D\u53BB\u7F51\u9875\u65B0\u5EFA\u5BF9\u8BDD\u5E76\u66F4\u65B0\u7ED1\u5B9A URL\u3002")), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-1.5 shrink-0"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => resetSessionRoundsAndSummarize(activeGroupId),
    className: "px-2.5 py-1 rounded-xl bg-amber-500 hover:bg-amber-600 text-white text-[11px] font-semibold"
  }, "\uD83D\uDCCA \u751F\u6210\u7ED3\u8BBA\u5361\u5E76\u6E05\u96F6\u8F6E\u6570"), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      updateGroupState(activeGroupId, state => ({
        ...state,
        sessionRounds: 0
      }));
      setActiveTab('sync');
    },
    className: `px-2.5 py-1 rounded-xl border text-[11px] font-medium ${darkMode ? 'border-amber-400/30 hover:bg-white/10' : 'border-amber-300 bg-white hover:bg-amber-100/50'}`
  }, "\u53BB\u6362\u65B0\u5BF9\u8BDD URL")))), messages.map(msg => {
    const isMe = msg.senderId === 'me';
    const bot = bots.find(b => b.id === msg.senderId);
    if (msg.type === 'conclusion-card') {
      const conclusionPlain = `【一页纸讨论结论 · ${activeGroup?.name || ''}】\n核心共识：${msg.sections?.core || ''}\n关键分歧点：${msg.sections?.disagreements || ''}\n最终落地建议：${msg.sections?.recommendation || ''}`;
      return /*#__PURE__*/React.createElement("article", {
        key: msg.id,
        ref: element => {
          if (element) messageElementRefs.current.set(msg.id, element);else messageElementRefs.current.delete(msg.id);
        },
        className: `mx-auto max-w-2xl rounded-[24px] border p-5 shadow-xl backdrop-blur-xl ${darkMode ? 'bg-gradient-to-br from-emerald-950/80 to-zinc-900/90 border-emerald-300/20 text-zinc-100' : 'bg-gradient-to-br from-emerald-50/95 to-white/95 border-emerald-200 text-zinc-800'} ${highlightedMessageId === msg.id ? 'ring-2 ring-emerald-400 animate-pulse' : ''}`
      }, /*#__PURE__*/React.createElement("div", {
        className: "flex items-center justify-between gap-3 mb-4"
      }, /*#__PURE__*/React.createElement("div", {
        className: "flex items-center gap-2"
      }, /*#__PURE__*/React.createElement("span", {
        className: "w-8 h-8 rounded-2xl bg-emerald-500/15 text-emerald-500 inline-flex items-center justify-center"
      }, "\uD83D\uDCCA"), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
        className: "font-bold text-sm"
      }, "\u4E00\u9875\u7EB8\u8BA8\u8BBA\u7ED3\u8BBA"), /*#__PURE__*/React.createElement("div", {
        className: "text-[10px] opacity-55"
      }, "@", myProfile.name, " \xB7 ", msg.time))), /*#__PURE__*/React.createElement("div", {
        className: "flex items-center gap-2"
      }, /*#__PURE__*/React.createElement("button", {
        onClick: () => handleCopy(conclusionPlain, `conclusion-${msg.id}`),
        className: "text-[10px] px-2.5 py-1 rounded-full bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-700 dark:text-emerald-300 font-medium inline-flex items-center gap-1 transition-colors"
      }, copiedKey === `conclusion-${msg.id}` ? /*#__PURE__*/React.createElement(Check, {
        className: "w-3 h-3"
      }) : /*#__PURE__*/React.createElement(Copy, {
        className: "w-3 h-3"
      }), /*#__PURE__*/React.createElement("span", null, "\u590D\u5236\u7ED3\u8BBA")), /*#__PURE__*/React.createElement("span", {
        className: "text-[9px] px-2 py-1 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-300"
      }, "\u672C\u7FA4\u503C\u5B88\u6210\u679C"))), /*#__PURE__*/React.createElement("div", {
        className: "grid gap-3"
      }, [['核心共识', msg.sections?.core], ['关键分歧点', msg.sections?.disagreements], ['最终落地建议', msg.sections?.recommendation]].map(([title, content]) => /*#__PURE__*/React.createElement("section", {
        key: title,
        className: "rounded-2xl bg-white/55 dark:bg-white/[0.045] p-3.5 border border-white/50 dark:border-white/[0.06]"
      }, /*#__PURE__*/React.createElement("h3", {
        className: "text-[11px] font-bold text-emerald-700 dark:text-emerald-300 mb-1.5"
      }, title), /*#__PURE__*/React.createElement("p", {
        className: "text-[13px] leading-relaxed whitespace-pre-wrap"
      }, content)))));
    }
    const messageBubbleStyle = !isMe ? BUBBLE_STYLES.find(style => style.id === bot?.bubbleStyleId) || currentBubbleStyle : currentBubbleStyle;
    const syncedBots = activeBots.filter(b => getCursorForBot(b.id) >= msg.id);
    const isMsgSelected = selectedMsgIds.includes(msg.id);
    return /*#__PURE__*/React.createElement("div", {
      key: msg.id,
      ref: element => {
        if (element) messageElementRefs.current.set(msg.id, element);else messageElementRefs.current.delete(msg.id);
      },
      className: `group/message flex items-start gap-3 rounded-2xl transition-all ${highlightedMessageId === msg.id ? 'ring-2 ring-blue-400/80 shadow-[0_0_20px_rgba(0,122,255,0.25)]' : ''} ${isMe ? 'flex-row-reverse' : 'flex-row'}`
    }, msgSelectMode && /*#__PURE__*/React.createElement("div", {
      onClick: e => {
        e.stopPropagation();
        setSelectedMsgIds(prev => prev.includes(msg.id) ? prev.filter(id => id !== msg.id) : [...prev, msg.id]);
      },
      className: "pt-2.5 cursor-pointer shrink-0",
      title: "\u70B9\u51FB\u52FE\u9009/\u53D6\u6D88"
    }, /*#__PURE__*/React.createElement("div", {
      className: `w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all ${isMsgSelected ? 'bg-[#007AFF] border-[#007AFF] text-white shadow-xs' : darkMode ? 'border-white/30 bg-black/20 hover:border-white/60' : 'border-zinc-300 bg-white hover:border-blue-400'}`
    }, isMsgSelected && /*#__PURE__*/React.createElement("svg", {
      className: "w-3 h-3 stroke-current stroke-[3] fill-none",
      viewBox: "0 0 24 24"
    }, /*#__PURE__*/React.createElement("path", {
      strokeLinecap: "round",
      strokeLinejoin: "round",
      d: "M5 13l4 4L19 7"
    })))), /*#__PURE__*/React.createElement("div", {
      onClick: () => {
        setSelectedAvatarTarget(isMe ? 'me' : bot?.id || 'me');
        setActiveTab('settings');
      },
      className: "cursor-pointer hover:scale-105 transition-transform",
      title: "\u70B9\u51FB\u53EF\u81EA\u5B9A\u4E49\u8BE5\u89D2\u8272\u5934\u50CF\u4E0E\u5916\u89C2"
    }, isMe ? renderEntityAvatar('me', 'w-9 h-9', 'text-xs') : renderEntityAvatar(bot, 'w-9 h-9', 'text-xs')), /*#__PURE__*/React.createElement("div", {
      className: `flex flex-col max-w-[78%] sm:max-w-[70%] ${isMe ? 'items-end' : 'items-start'}`
    }, /*#__PURE__*/React.createElement("div", {
      className: "group flex items-center gap-2 mb-1.5 px-1"
    }, /*#__PURE__*/React.createElement("span", {
      className: "text-xs font-semibold tracking-tight"
    }, isMe ? myProfile.name : bot?.name || msg.senderName), !isMe && bot?.roleTag && /*#__PURE__*/React.createElement("span", {
      className: `text-[10px] px-2 py-0.5 rounded-full font-medium ${darkMode ? 'bg-white/[0.07] text-zinc-400' : 'bg-zinc-100 text-zinc-500'}`
    }, bot.roleTag), !isMe && bot && /*#__PURE__*/React.createElement("button", {
      onClick: event => {
        event.stopPropagation();
        setPersonaEditorBotId(bot.id);
      },
      title: `编辑 ${bot.name} 的人设`,
      "aria-label": `编辑 ${bot.name} 的人设`,
      className: `w-5 h-5 rounded-md inline-flex items-center justify-center opacity-55 hover:opacity-100 focus:opacity-100 transition-opacity ${darkMode ? 'hover:bg-white/10' : 'hover:bg-black/5'}`
    }, /*#__PURE__*/React.createElement(Pencil, {
      className: "w-3 h-3"
    })), /*#__PURE__*/React.createElement("span", {
      className: "text-[10px] opacity-40 font-mono"
    }, msg.time, " \xB7 #", msg.id)), /*#__PURE__*/React.createElement("div", {
      style: isMe ? myBubbleColorId === 'custom' ? {
        backgroundColor: myBubbleCustomBg,
        color: myBubbleCustomText
      } : undefined : getBotBubbleInlineStyle(bot),
      className: `text-[14px] leading-relaxed transition-all ${messageBubbleStyle.extraClass} ${isMe ? `${messageBubbleStyle.meRadius} ${currentMyBubbleColor.className}` : `${messageBubbleStyle.botRadius} ${getBotBubbleClasses(bot)}`}`
    }, msg.forwardedFrom && /*#__PURE__*/React.createElement("div", {
      className: `mb-2 pb-1.5 border-b text-[11px] flex flex-wrap items-center gap-1.5 ${isMe ? 'border-white/25 text-white/90' : darkMode ? 'border-white/15 text-blue-300' : 'border-black/10 text-blue-600'}`
    }, /*#__PURE__*/React.createElement(CornerUpRight, {
      className: "w-3 h-3 shrink-0"
    }), /*#__PURE__*/React.createElement("span", {
      className: "font-semibold"
    }, "\u8F6C\u53D1\u81EA\u7FA4\u804A\u300C", msg.forwardedFrom.groupName, "\u300D"), /*#__PURE__*/React.createElement("span", {
      className: "opacity-75"
    }, "\xB7"), /*#__PURE__*/React.createElement("span", {
      className: "font-semibold"
    }, "\u539F\u53D1\u8A00\uFF1A", msg.forwardedFrom.senderName, msg.forwardedFrom.roleTag ? ` (${msg.forwardedFrom.roleTag})` : '')), msg.text && /*#__PURE__*/React.createElement("div", {
      className: "whitespace-pre-wrap"
    }, msg.text), msg.attachments?.length > 0 && /*#__PURE__*/React.createElement("div", {
      className: `grid gap-2 ${msg.attachments.length > 1 ? 'grid-cols-2' : 'grid-cols-1'} ${msg.text ? 'mt-2' : ''}`
    }, msg.attachments.map(attachment => /*#__PURE__*/React.createElement("div", {
      key: attachment.id || attachment.url,
      className: "overflow-hidden rounded-xl"
    }, attachment.type?.startsWith('video/') ? /*#__PURE__*/React.createElement("video", {
      src: attachment.url,
      controls: true,
      playsInline: true,
      className: "max-h-72 max-w-full rounded-xl"
    }) : attachment.type?.startsWith('image/') ? /*#__PURE__*/React.createElement("a", {
      href: attachment.url,
      target: "_blank",
      rel: "noreferrer",
      onClick: event => event.stopPropagation()
    }, /*#__PURE__*/React.createElement("img", {
      src: attachment.url,
      alt: attachment.name || '聊天图片',
      className: "max-h-72 max-w-full rounded-xl object-contain"
    })) : /*#__PURE__*/React.createElement("a", {
      href: attachment.url,
      target: "_blank",
      rel: "noreferrer",
      className: "text-xs underline"
    }, attachment.name || '查看附件'))))), msg.replyTo && /*#__PURE__*/React.createElement("button", {
      onClick: event => {
        event.stopPropagation();
        scrollToMessage(msg.replyTo.id);
      },
      title: `定位到 ${msg.replyTo.senderName} 的原消息`,
      className: `mt-1 max-w-full px-2.5 py-1 text-[11px] leading-snug text-left rounded-lg border-l-2 border-blue-500/50 truncate line-clamp-2 ${darkMode ? 'bg-white/[0.07] text-zinc-300 border-white/[0.12]' : 'bg-zinc-200/75 text-zinc-600 border-zinc-400/70'}`
    }, /*#__PURE__*/React.createElement("span", {
      className: "font-semibold"
    }, msg.replyTo.senderName, "\uFF1A"), msg.replyTo.text), /*#__PURE__*/React.createElement("div", {
      className: "flex flex-wrap items-center gap-2 mt-1.5 px-1"
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex items-center gap-1 text-[10px] opacity-55"
    }, /*#__PURE__*/React.createElement("span", null, "\u5DF2\u540C\u6B65\u81F3\u7F51\u9875:"), /*#__PURE__*/React.createElement("div", {
      className: "flex items-center -space-x-1"
    }, syncedBots.map(sb => /*#__PURE__*/React.createElement("span", {
      key: sb.id,
      title: `${sb.name} 的网页对话已包含此消息`,
      className: "ring-1 ring-white dark:ring-zinc-900 rounded-full"
    }, renderEntityAvatar(sb, 'w-4 h-4', 'text-[7px]', true))))), canMeQuote() && /*#__PURE__*/React.createElement("button", {
      onClick: event => {
        event.stopPropagation();
        beginQuote(msg);
      },
      className: `opacity-0 group-hover/message:opacity-70 hover:!opacity-100 focus:opacity-100 text-[10px] inline-flex items-center gap-1 transition-opacity ${darkMode ? 'text-zinc-300' : 'text-zinc-600'}`,
      title: "\u5F15\u7528\u8FD9\u6761\u6D88\u606F\u56DE\u590D"
    }, /*#__PURE__*/React.createElement(Quote, {
      className: "w-3 h-3"
    }), "\u5F15\u7528"), !isMe && msg.deltaPayload && /*#__PURE__*/React.createElement("button", {
      onClick: () => setSelectedMsgForInspect(selectedMsgForInspect?.id === msg.id ? null : msg),
      className: `text-[10px] px-2.5 py-0.5 rounded-full font-medium flex items-center gap-1 transition-all ${selectedMsgForInspect?.id === msg.id ? 'bg-blue-600 text-white' : darkMode ? 'bg-white/[0.06] hover:bg-white/[0.12] text-zinc-300' : 'bg-zinc-100 hover:bg-zinc-200/80 text-zinc-600'}`
    }, /*#__PURE__*/React.createElement(Eye, {
      className: "w-3 h-3"
    }), /*#__PURE__*/React.createElement("span", null, selectedMsgForInspect?.id === msg.id ? '收起网页增量注入包' : '查看实际注入网页的增量上下文'))), selectedMsgForInspect?.id === msg.id && /*#__PURE__*/React.createElement("div", {
      className: `mt-2.5 p-3.5 rounded-2xl text-xs font-mono w-full border shadow-xl transition-all ${darkMode ? 'bg-black/80 border-white/15 text-emerald-300' : 'bg-zinc-900 border-zinc-800 text-emerald-300'}`
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex items-center justify-between text-[11px] text-zinc-400 mb-2 pb-1.5 border-b border-white/10"
    }, /*#__PURE__*/React.createElement("span", {
      className: "truncate"
    }, "\uD83C\uDFAF \u6CE8\u5165\u76EE\u6807: ", bot?.targetUrl), /*#__PURE__*/React.createElement("span", {
      className: "text-emerald-400 shrink-0 ml-2"
    }, "\u4EC5\u53D1\u672A\u8BFB\u589E\u91CF \xB7 \u96F6\u91CD\u590D\u5386\u53F2")), /*#__PURE__*/React.createElement("pre", {
      className: "whitespace-pre-wrap text-[11px] leading-relaxed"
    }, msg.deltaPayload))));
  }), /*#__PURE__*/React.createElement("div", {
    ref: chatEndRef
  }), msgSelectMode && /*#__PURE__*/React.createElement("div", {
    className: "sticky bottom-2 z-40 mx-auto max-w-lg p-3 rounded-2xl backdrop-blur-2xl border shadow-2xl flex items-center justify-between gap-3 bg-white/95 dark:bg-zinc-900/95 border-zinc-200 dark:border-white/10 animate-in fade-in slide-in-from-bottom-2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-xs font-bold text-zinc-900 dark:text-white"
  }, "\u5DF2\u9009 ", /*#__PURE__*/React.createElement("b", {
    className: "font-mono text-blue-500"
  }, selectedMsgIds.length), " \u6761\u6D88\u606F"), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      if (selectedMsgIds.length === messages.length) setSelectedMsgIds([]);else setSelectedMsgIds(messages.map(m => m.id));
    },
    className: "text-[11px] text-blue-500 hover:underline font-medium"
  }, selectedMsgIds.length === messages.length ? '取消全选' : '全选所有')), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setMsgSelectMode(null);
      setSelectedMsgIds([]);
    },
    className: "px-3 py-1.5 rounded-xl border text-xs font-medium hover:bg-black/5 dark:hover:bg-white/10"
  }, "\u53D6\u6D88"), /*#__PURE__*/React.createElement("button", {
    disabled: selectedMsgIds.length === 0,
    onClick: () => {
      if (selectedMsgIds.length === 0) return;
      if (msgSelectMode === 'pin') {
        // 确定置顶
        updateGroupState(activeGroupId, state => ({
          ...state,
          pinnedMessageIds: Array.from(new Set([...(state.pinnedMessageIds || []), ...selectedMsgIds]))
        }));
        showToast(`已将 ${selectedMsgIds.length} 条消息置顶至右栏焦点`);
        setMsgSelectMode(null);
        setSelectedMsgIds([]);
      } else if (msgSelectMode === 'delete') {
        // 确定永久删除
        const idsToDelete = new Set(selectedMsgIds);
        const currentMsgs = groupMessagesRef.current[activeGroupId] || messages;
        const nextMsgs = currentMsgs.filter(m => !idsToDelete.has(m.id));
        updateGroupMessages(nextMsgs, activeGroupId);
        updateGroupState(activeGroupId, state => ({
          ...state,
          pinnedMessageIds: (state.pinnedMessageIds || []).filter(id => !idsToDelete.has(id))
        }));
        showToast(`已永久删除选中的 ${selectedMsgIds.length} 条消息`);
        setMsgSelectMode(null);
        setSelectedMsgIds([]);
      } else if (msgSelectMode === 'forward') {
        // 弹出转发弹窗
        setForwardModalOpen(true);
      }
    },
    className: `px-4 py-1.5 rounded-xl text-xs font-semibold text-white shadow-sm transition-all ${selectedMsgIds.length === 0 ? 'opacity-40 cursor-not-allowed bg-zinc-400' : msgSelectMode === 'delete' ? 'bg-rose-500 hover:bg-rose-600' : msgSelectMode === 'pin' ? 'bg-amber-500 hover:bg-amber-600' : 'bg-[#007AFF] hover:bg-blue-600'}`
  }, msgSelectMode === 'pin' ? '确定置顶' : msgSelectMode === 'delete' ? '永久删除' : '确定转发')))), forwardModalOpen && /*#__PURE__*/React.createElement("div", {
    className: "fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
  }, /*#__PURE__*/React.createElement("div", {
    className: `w-full max-w-lg p-5 rounded-3xl border shadow-2xl ${darkMode ? 'bg-zinc-900 border-white/10 text-white' : 'bg-white border-zinc-200 text-zinc-900'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-between pb-3 border-b border-inherit mb-4"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "font-bold text-sm flex items-center gap-2"
  }, /*#__PURE__*/React.createElement(CornerUpRight, {
    className: "w-4 h-4 text-blue-500"
  }), /*#__PURE__*/React.createElement("span", null, "\u8DE8\u7FA4\u8F6C\u53D1\u6D88\u606F (", selectedMsgIds.length, " \u6761)")), /*#__PURE__*/React.createElement("p", {
    className: "text-[11px] opacity-60 mt-0.5"
  }, "\u5DF2\u81EA\u52A8\u9644\u5E26\u300C\u6E90\u7FA4\u804A + \u539F\u53D1\u8A00 AI\u300D\u53CC\u91CD\u6765\u6E90\u6807\u7B7E\uFF0C\u63A5\u6536\u7FA4\u7684 AI \u4F1A\u660E\u786E\u77E5\u6653\u6D88\u606F\u51FA\u5904")), /*#__PURE__*/React.createElement("button", {
    onClick: () => setForwardModalOpen(false),
    className: "opacity-60 hover:opacity-100"
  }, /*#__PURE__*/React.createElement(X, {
    className: "w-4 h-4"
  }))), /*#__PURE__*/React.createElement("div", {
    className: "space-y-3 mb-4"
  }, /*#__PURE__*/React.createElement("div", {
    className: `p-3 rounded-2xl border text-[11px] space-y-1.5 ${darkMode ? 'bg-blue-950/25 border-blue-500/30 text-blue-200' : 'bg-blue-50/80 border-blue-200 text-blue-900'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "font-bold flex items-center justify-between"
  }, /*#__PURE__*/React.createElement("span", null, "\uD83D\uDCE8 \u63A5\u6536\u7FA4 AI \u5C06\u770B\u5230\u7684\u6765\u6E90\u6807\u8BB0\u9884\u89C8\uFF1A"), /*#__PURE__*/React.createElement("span", {
    className: "text-[10px] px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-500 font-semibold"
  }, "\u6765\u6E90100%\u900F\u4F20")), messages.filter(m => selectedMsgIds.includes(m.id)).slice(0, 2).map(m => {
    const srcGroup = m.forwardedFrom?.groupName || activeGroup?.name || '当前群聊';
    const srcSpeaker = m.forwardedFrom?.senderName || m.senderName;
    const originBot = bots.find(b => b.id === (m.forwardedFrom?.senderId || m.senderId));
    const srcRole = m.forwardedFrom?.roleTag || originBot?.roleTag || (m.senderId === 'me' ? '主理人' : 'AI 群友');
    return /*#__PURE__*/React.createElement("div", {
      key: m.id,
      className: "font-mono text-[10px] truncate opacity-90"
    }, "\uD83D\uDCE8 [\u8F6C\u53D1\u81EA\u7FA4\u804A\u300C", srcGroup, "\u300D\xB7 \u539F\u53D1\u8A00\u4EBA\u300C", srcSpeaker, " \xB7 ", srcRole, "\u300D]: ", (m.text || '媒体附件').slice(0, 42));
  }), selectedMsgIds.length > 2 && /*#__PURE__*/React.createElement("div", {
    className: "text-[10px] opacity-65"
  }, "\u2026\u7B49\u5171 ", selectedMsgIds.length, " \u6761\u5E26\u6765\u6E90\u7F72\u540D\u7684\u6D88\u606F")), /*#__PURE__*/React.createElement("label", {
    className: `p-3 rounded-2xl border flex items-center justify-between cursor-pointer ${forwardAllGroups ? 'bg-blue-500/10 border-blue-400' : darkMode ? 'bg-white/5 border-white/10' : 'bg-zinc-50 border-zinc-200'}`
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-xs font-bold flex items-center gap-1.5"
  }, /*#__PURE__*/React.createElement(Share2, {
    className: "w-3.5 h-3.5 text-blue-500"
  }), /*#__PURE__*/React.createElement("span", null, "\uD83D\uDCE2 \u4E00\u952E\u7FA4\u53D1\u5230\u6240\u6709\u5176\u4ED6\u7FA4\u804A")), /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: forwardAllGroups,
    onChange: e => setForwardAllGroups(e.target.checked),
    className: "w-4 h-4 rounded text-blue-500"
  })), !forwardAllGroups && /*#__PURE__*/React.createElement("div", {
    className: "space-y-1.5 max-h-40 overflow-y-auto pr-1"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-[11px] opacity-60 mb-1"
  }, "\u9009\u62E9\u8981\u63A5\u6536\u8F6C\u53D1\u7684\u76EE\u6807\u7FA4\u804A\uFF1A"), groups.filter(g => g.id !== activeGroupId).map(g => {
    const isChecked = forwardTargetGroupIds.includes(g.id);
    return /*#__PURE__*/React.createElement("label", {
      key: g.id,
      className: `p-2.5 rounded-xl border flex items-center justify-between text-xs cursor-pointer ${isChecked ? 'bg-blue-500/10 border-blue-400' : darkMode ? 'bg-white/5 border-white/10' : 'bg-zinc-50 border-zinc-200'}`
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex items-center gap-2"
    }, /*#__PURE__*/React.createElement("span", {
      className: "font-medium"
    }, g.name), /*#__PURE__*/React.createElement("span", {
      className: "text-[10px] opacity-50"
    }, "(", (g.memberIds || []).length, " \u4F4D AI)")), /*#__PURE__*/React.createElement("input", {
      type: "checkbox",
      checked: isChecked,
      onChange: e => {
        if (e.target.checked) setForwardTargetGroupIds(prev => [...prev, g.id]);else setForwardTargetGroupIds(prev => prev.filter(id => id !== g.id));
      },
      className: "w-4 h-4 rounded text-blue-500"
    }));
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "block text-[11px] font-medium opacity-70 mb-1"
  }, "\uD83D\uDCAC \u9644\u5E26\u8F6C\u53D1\u7559\u8A00\uFF08\u53EF\u9009\uFF0C\u968F\u8F6C\u53D1\u6D88\u606F\u4E00\u8D77\u53D1\u7ED9\u76EE\u6807\u7FA4 AI\uFF09\uFF1A"), /*#__PURE__*/React.createElement("input", {
    type: "text",
    value: forwardComment,
    onChange: e => setForwardComment(e.target.value),
    placeholder: "\u4F8B\u5982\uFF1A\u4F60\u4EEC\u770B\u770B\u9694\u58C1\u7FA4 DeepSeek \u63D0\u7684\u8FD9\u4E2A\u65B9\u6848\u9760\u8C31\u5417\uFF1F",
    className: `w-full px-3 py-2 rounded-xl border text-xs ${darkMode ? 'bg-black/30 border-white/10 text-white' : 'bg-zinc-50 border-zinc-200 text-zinc-900'}`
  })), /*#__PURE__*/React.createElement("label", {
    className: `p-2.5 rounded-xl border flex items-center justify-between cursor-pointer text-xs ${darkMode ? 'bg-white/[0.03] border-white/10' : 'bg-zinc-50 border-zinc-200'}`
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "font-semibold"
  }, "\u26A1 \u8F6C\u53D1\u540E\u7ACB\u5373\u5524\u9192\u76EE\u6807\u7FA4 AI \u70B9\u8BC4\u56DE\u5E94"), /*#__PURE__*/React.createElement("div", {
    className: "text-[10px] opacity-55"
  }, "\u5173\u95ED\u5219\u4EC5\u4F5C\u4E3A\u672A\u8BFB\u589E\u91CF\u4E0A\u4E0B\u6587\u5B58\u5165\u76EE\u6807\u7FA4\uFF0C\u7B49\u4F60\u5207\u8FC7\u53BB\u53D1\u8A00\u65F6\u4E00\u5E76\u540C\u6B65")), /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: Boolean(featureSettings.autoDispatchOnForward),
    onChange: e => setFeatureSettings(prev => ({
      ...prev,
      autoDispatchOnForward: e.target.checked
    })),
    className: "w-4 h-4 rounded text-blue-500"
  }))), /*#__PURE__*/React.createElement("div", {
    className: "flex justify-end gap-2"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setForwardModalOpen(false),
    className: "px-4 py-2 rounded-xl text-xs font-medium hover:bg-black/5 dark:hover:bg-white/10"
  }, "\u53D6\u6D88"), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      const targetIds = forwardAllGroups ? groups.filter(g => g.id !== activeGroupId).map(g => g.id) : forwardTargetGroupIds;
      if (!targetIds.length) {
        showToast('请至少选择一个目标群聊或勾选一键群发');
        return;
      }
      const msgsToForward = messages.filter(m => selectedMsgIds.includes(m.id));
      const nowTime = new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit'
      });
      const trimmedNote = forwardComment.trim();
      targetIds.forEach(gid => {
        const existing = groupMessagesRef.current[gid] || [];
        let maxId = existing.reduce((max, m) => Math.max(max, m.id || 0), 0);
        const cloned = msgsToForward.map(m => {
          const originBot = bots.find(b => b.id === (m.forwardedFrom?.senderId || m.senderId));
          const srcGroupId = m.forwardedFrom?.groupId || activeGroupId;
          const srcGroupName = m.forwardedFrom?.groupName || activeGroup?.name || '其他群聊';
          const srcSenderId = m.forwardedFrom?.senderId || m.senderId;
          const srcSenderName = m.forwardedFrom?.senderName || m.senderName || (m.senderId === 'me' ? myProfile.name || '我 (主理人)' : 'AI 群友');
          const srcRoleTag = m.forwardedFrom?.roleTag || originBot?.roleTag || (srcSenderId === 'me' ? '主理人' : 'AI 群友');
          const srcPlatform = m.forwardedFrom?.platform || originBot?.platform || '';
          return {
            ...m,
            id: ++maxId,
            time: nowTime,
            syncedTo: ['me'],
            forwardedFrom: {
              groupId: srcGroupId,
              groupName: srcGroupName,
              senderId: srcSenderId,
              senderName: srcSenderName,
              roleTag: srcRoleTag,
              platform: srcPlatform,
              originalTime: m.time || ''
            },
            deltaPayload: `📨 [转发消息｜来自群聊「${srcGroupName}」的原发言人「${srcSenderName} · ${srcRoleTag}」]: ${m.text || ''}`
          };
        });
        if (trimmedNote) {
          cloned.push({
            id: ++maxId,
            senderId: 'me',
            senderName: myProfile.name || '我 (主理人)',
            text: trimmedNote,
            attachments: [],
            time: nowTime,
            syncedTo: ['me']
          });
        }
        const updatedTargetMsgs = [...existing, ...cloned];
        updateGroupMessages(updatedTargetMsgs, gid);

        // 若开启了转发后自动唤醒目标群 AI，则自动唤醒目标群首位可用 AI 接话点评
        if (featureSettingsRef.current.autoDispatchOnForward) {
          const targetGroupObj = groupsRef.current.find(g => g.id === gid);
          const targetGroupBots = botsRef.current.filter(b => targetGroupObj?.memberIds?.includes(b.id) && b.targetUrl && !groupStatesRef.current[gid]?.circuitBrokenBots?.[b.id]);
          if (targetGroupBots.length > 0) {
            const firstTargetBot = targetGroupBots[0];
            const remainingChain = targetGroupBots.slice(1).map(b => b.id);
            activeChainRef.current.set(gid, {
              chain: remainingChain,
              step: 0
            });
            setTimeout(() => {
              enqueueBotReply(firstTargetBot.id, updatedTargetMsgs, gid, 'required', true, {
                dispatchBatchId: `${gid}-forward-${Date.now()}`
              });
            }, 300);
          }
        }
      });
      showToast(`已携带「源群聊+原AI署名」转发至 ${targetIds.length} 个群聊！`);
      setForwardComment('');
      setForwardModalOpen(false);
      setMsgSelectMode(null);
      setSelectedMsgIds([]);
    },
    className: "px-4 py-2 rounded-xl bg-[#007AFF] hover:bg-blue-600 text-white text-xs font-semibold shadow-sm"
  }, "\u7ACB\u5373\u5E26\u7F72\u540D\u8F6C\u53D1")))), /*#__PURE__*/React.createElement("div", {
    className: "px-4 sm:px-10 pb-5 pt-1 shrink-0"
  }, /*#__PURE__*/React.createElement("div", {
    "data-webh-composer": "true",
    className: `${activeTab === 'groups' ? 'hidden' : ''} rounded-[26px] p-2.5 border transition-all shadow-xl backdrop-blur-2xl ${darkMode ? 'bg-zinc-800/85 border-white/[0.09] shadow-black/60 focus-within:border-blue-500/40' : 'bg-white/95 border-zinc-200/80 shadow-zinc-200/90 focus-within:border-blue-400/70'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-between gap-1 px-1 pb-2 mb-1 border-b border-zinc-200/40 dark:border-white/[0.05] overflow-x-auto no-scrollbar"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-1 shrink-0"
  }, activeBots.map(b => {
    const shortName = b.name.split(' ')[0];
    return /*#__PURE__*/React.createElement("button", {
      key: b.id,
      type: "button",
      onClick: () => {
        setInputText(prev => {
          const prefix = `@${shortName} `;
          return prev.includes(prefix) ? prev : `${prev}${prefix}`;
        });
        if (composerInputRef.current) {
          composerInputRef.current.focus();
        }
      },
      className: `inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium border transition-all ${inputText.includes(`@${shortName}`) ? 'bg-[#007AFF] text-white border-[#007AFF]' : darkMode ? 'bg-white/[0.05] active:bg-white/15 border-white/[0.08] text-zinc-200' : 'bg-zinc-100 active:bg-zinc-200 border-zinc-200/70 text-zinc-700'}`
    }, renderEntityAvatar(b, 'w-3.5 h-3.5', 'text-[7px]', true), /*#__PURE__*/React.createElement("span", null, "@", shortName));
  })), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => setSplitWebViewOpen(v => !v),
    className: `px-2 py-0.5 rounded-full text-[11px] font-medium shrink-0 border ${splitWebViewOpen ? 'bg-[#007AFF] text-white border-[#007AFF]' : darkMode ? 'bg-white/[0.05] border-white/10 text-zinc-300' : 'bg-zinc-100 border-zinc-200 text-zinc-600'}`
  }, splitWebViewOpen ? '收起同屏' : '同屏')), pendingQuote?.groupId === activeGroupId && /*#__PURE__*/React.createElement("div", {
    className: `mx-2 mb-2 px-2.5 py-1.5 rounded-xl border-l-2 border-blue-500 flex items-center gap-2 text-[11px] ${darkMode ? 'bg-white/[0.06] border-white/10 text-zinc-300' : 'bg-zinc-100 border-zinc-200 text-zinc-600'}`
  }, /*#__PURE__*/React.createElement(Quote, {
    className: "w-3 h-3 shrink-0 text-blue-500"
  }), /*#__PURE__*/React.createElement("span", {
    className: "truncate flex-1"
  }, /*#__PURE__*/React.createElement("b", null, pendingQuote.senderName, "\uFF1A"), pendingQuote.text), /*#__PURE__*/React.createElement("button", {
    onClick: () => setPendingQuote(null),
    title: "\u53D6\u6D88\u5F15\u7528",
    className: "opacity-60 hover:opacity-100"
  }, /*#__PURE__*/React.createElement(X, {
    className: "w-3 h-3"
  }))), pendingAttachments.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap gap-2 px-2 pb-2"
  }, pendingAttachments.map(attachment => /*#__PURE__*/React.createElement("div", {
    key: attachment.id,
    className: `relative w-16 h-16 rounded-xl overflow-hidden border ${darkMode ? 'border-white/15 bg-black/30' : 'border-zinc-200 bg-zinc-50'}`
  }, attachment.type.startsWith('image/') ? /*#__PURE__*/React.createElement("img", {
    src: attachment.url,
    alt: attachment.name,
    className: "w-full h-full object-cover"
  }) : /*#__PURE__*/React.createElement("div", {
    className: "w-full h-full flex flex-col items-center justify-center gap-1 text-[9px] opacity-70"
  }, /*#__PURE__*/React.createElement(Video, {
    className: "w-5 h-5"
  }), /*#__PURE__*/React.createElement("span", {
    className: "max-w-[56px] truncate"
  }, attachment.name)), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      attachmentFilesRef.current.delete(attachment.id);
      if (attachment.url?.startsWith('blob:')) URL.revokeObjectURL(attachment.url);
      setPendingAttachments(previous => previous.filter(item => item.id !== attachment.id));
    },
    className: "absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-black/70 text-white flex items-center justify-center",
    title: "\u79FB\u9664\u9644\u4EF6"
  }, /*#__PURE__*/React.createElement(X, {
    className: "w-3 h-3"
  }))))), /*#__PURE__*/React.createElement("div", {
    className: "relative flex items-end gap-2 pl-1"
  }, /*#__PURE__*/React.createElement("input", {
    ref: filePickerInputRef,
    type: "file",
    accept: "*/*",
    multiple: true,
    onChange: handleAttachmentFiles,
    className: "hidden"
  }), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => setUploadMenuOpen(v => !v),
    className: `relative w-8 h-8 rounded-full flex items-center justify-center shrink-0 border transition-all ${uploadMenuOpen || hasEphemeralAiClip ? 'bg-[#007AFF] text-white border-[#007AFF] shadow-sm' : darkMode ? 'bg-white/10 border-white/15 text-zinc-200 hover:bg-white/15' : 'bg-zinc-100 border-zinc-200/80 text-zinc-700 hover:bg-zinc-200'}`,
    title: "\u4E0A\u4F20\u56FE\u7247/\u89C6\u9891/\u6587\u4EF6 \u6216 \u63A5\u6536\u5355\u6B21\u590D\u5236\u7684AI\u56DE\u590D\u4E0E\u5A92\u4F53"
  }, /*#__PURE__*/React.createElement(Upload, {
    className: "w-4 h-4"
  }), hasEphemeralAiClip && /*#__PURE__*/React.createElement("span", {
    className: "absolute -top-1 -right-1 w-3 h-3 rounded-full bg-emerald-400 ring-2 ring-white animate-ping"
  })), uploadMenuOpen && /*#__PURE__*/React.createElement("div", {
    className: `absolute left-0 bottom-11 z-50 w-64 p-2 rounded-3xl backdrop-blur-3xl border shadow-2xl space-y-1.5 ${darkMode ? 'bg-zinc-900/95 border-white/15 text-zinc-100' : 'bg-white/95 border-white/90 text-zinc-800'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "px-2.5 py-1 text-[10px] font-bold opacity-55 border-b border-current/10"
  }, "\u5A92\u4F53\u6587\u4EF6\u4E0A\u4F20\u4E0E AI \u56DE\u590D\u5355\u6B21\u63A5\u6536"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => {
      if (filePickerInputRef.current) filePickerInputRef.current.click();
    },
    className: `w-full px-3 py-2.5 rounded-2xl text-xs font-semibold flex items-center gap-2.5 text-left transition-all ${darkMode ? 'hover:bg-white/10 active:bg-white/15' : 'hover:bg-black/5 active:bg-black/10'}`
  }, /*#__PURE__*/React.createElement(Upload, {
    className: "w-4 h-4 text-[#007AFF] shrink-0"
  }), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", null, "\u4E0A\u4F20\u624B\u673A\u56FE\u7247 / \u89C6\u9891 / \u6587\u4EF6"), /*#__PURE__*/React.createElement("div", {
    className: "text-[10px] opacity-55 font-normal"
  }, "\u652F\u6301\u76F8\u518C\u3001\u89C6\u9891\u4E0E\u5404\u7C7B\u6587\u6863\u9644\u4EF6"))), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: consumeOneTimeEphemeralAiCopyToChat,
    className: `w-full px-3 py-2.5 rounded-2xl text-xs font-semibold flex items-center gap-2.5 text-left transition-all ${hasEphemeralAiClip ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border border-emerald-500/30' : darkMode ? 'hover:bg-white/10 active:bg-white/15' : 'hover:bg-black/5 active:bg-black/10'}`
  }, /*#__PURE__*/React.createElement(Download, {
    className: "w-4 h-4 text-emerald-500 shrink-0"
  }), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", null, "\u63A5\u6536\u590D\u5236\u7684 AI \u56DE\u590D/\u56FE/\u89C6\u9891/\u6587\u4EF6"), /*#__PURE__*/React.createElement("div", {
    className: "text-[10px] opacity-65 font-normal"
  }, hasEphemeralAiClip ? '✨ 已就绪：点击立即粘贴并清空缓存' : '复制仅记忆一次 · 绝不占用手机内存')))), /*#__PURE__*/React.createElement("textarea", {
    ref: composerInputRef,
    value: inputText,
    onChange: e => setInputText(e.target.value),
    onKeyDown: e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        handleSendMessage();
      }
    },
    rows: 1,
    placeholder: "\u70B9\u51FB\u4E0A\u65B9 @AI \u70B9\u540D\u63D0\u95EE\uFF0C\u6216\u76F4\u63A5\u8F93\u5165\u6D88\u606F\u53D1\u9001\u2026",
    className: "flex-1 bg-transparent py-1.5 text-sm focus:outline-none resize-none max-h-28 placeholder:opacity-40"
  }), /*#__PURE__*/React.createElement("button", {
    onClick: () => handleSendMessage(),
    className: "w-8 h-8 rounded-full bg-[#007AFF] hover:bg-blue-600 active:scale-95 text-white flex items-center justify-center shrink-0 shadow-md shadow-blue-500/30 transition-all",
    title: "\u53D1\u9001\u6D88\u606F (Enter)"
  }, /*#__PURE__*/React.createElement(ArrowUp, {
    className: "w-4 h-4 stroke-[2.5]"
  })))))), !isMinimizedToIsland && activeTab === 'sync' && /*#__PURE__*/React.createElement("div", {
    onClick: () => islandExpanded && setIslandExpanded(false),
    className: "flex-1 overflow-y-auto p-6 space-y-6"
  }, /*#__PURE__*/React.createElement("div", {
    className: "max-w-4xl mx-auto space-y-5"
  }, /*#__PURE__*/React.createElement("div", {
    className: "space-y-3"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-start justify-between gap-3"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h2", {
    className: "text-base font-extrabold tracking-tight flex items-center gap-2"
  }, /*#__PURE__*/React.createElement(Link2, {
    className: "w-4 h-4 text-blue-500"
  }), /*#__PURE__*/React.createElement("span", null, "\u7ED1\u5B9A\u5404\u5E73\u53F0 AI \u7684\u300C\u6307\u5B9A\u7F51\u9875\u5BF9\u8BDD URL\u300D\u4E0E\u4EBA\u8BBE")), /*#__PURE__*/React.createElement("p", {
    className: "text-xs opacity-65 mt-1"
  }, "\u4E3A\u6BCF\u4F4D\u804A\u5929\u4EBA\u7ED1\u5B9A\u56FA\u5B9A\u7F51\u9875\u5BF9\u8BDD\u5730\u5740\u3002\u70B9\u51FB\u53F3\u4FA7\u82F9\u679C\u6BDB\u73BB\u7483\u9F7F\u8F6E\u6309\u94AE\u53EF\u6253\u5F00\u5B8C\u6574\u7CFB\u7EDF\u8BBE\u7F6E\u3002"))), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-between gap-2 pt-1 pb-1"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-1.5 flex-wrap"
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => setActiveTab('sync'),
    className: `px-3 py-1.5 rounded-full text-xs font-semibold border transition-all ${activeTab === 'sync' ? 'bg-[#007AFF] text-white border-[#007AFF] shadow-xs' : darkMode ? 'bg-white/5 border-white/10 text-zinc-300' : 'bg-white/80 border-zinc-200 text-zinc-700'}`
  }, "\uD83D\uDD17 \u7F51\u9875\u7ED1\u5B9A"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => setActiveTab('anti-preach'),
    className: `px-3 py-1.5 rounded-full text-xs font-semibold border transition-all ${activeTab === 'anti-preach' ? 'bg-[#007AFF] text-white border-[#007AFF] shadow-xs' : darkMode ? 'bg-white/5 border-white/10 text-zinc-300' : 'bg-white/80 border-zinc-200 text-zinc-700'}`
  }, "\uD83C\uDFAD \u53BB\u8BF4\u6559\u4E0E\u4EBA\u8BBE\u5E93"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: startNewBot,
    className: "px-3 py-1.5 rounded-full bg-blue-500/15 text-[#007AFF] text-xs font-semibold flex items-center gap-1"
  }, /*#__PURE__*/React.createElement(Plus, {
    className: "w-3.5 h-3.5"
  }), /*#__PURE__*/React.createElement("span", null, "\u6DFB\u52A0AI"))), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2 pr-2 shrink-0"
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => setSystemSettingsOpen(true),
    title: "\u6253\u5F00\u5B8C\u6574\u7CFB\u7EDF\u8BBE\u7F6E\u4E2D\u5FC3\uFF08\u8C03\u8282\u53D1\u8A00\u8C03\u5EA6\u3001\u5F15\u7528\u89C4\u5219\u3001\u8DE8\u7FA4\u8F6C\u53D1\u3001\u5B57\u6570\u4E0E\u9632\u5C01\u7B49\u5168\u90E8\u539F\u7248\u8BBE\u7F6E\uFF09",
    "aria-label": "\u6253\u5F00\u5B8C\u6574\u7CFB\u7EDF\u8BBE\u7F6E\u4E2D\u5FC3",
    className: `w-12 h-12 rounded-full backdrop-blur-2xl border flex items-center justify-center transition-all active:scale-90 ${darkMode ? 'bg-zinc-900/65 border-white/25 text-blue-400 shadow-[0_10px_28px_rgba(0,0,0,0.45),inset_0_1px_2px_rgba(255,255,255,0.25)]' : 'bg-white/70 border-white/95 text-[#007AFF] shadow-[0_10px_28px_rgba(0,122,255,0.20),inset_0_1px_2px_rgba(255,255,255,0.98)]'}`
  }, /*#__PURE__*/React.createElement(Settings, {
    className: "w-6 h-6"
  }))))), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-1 md:grid-cols-2 gap-4"
  }, bots.map(bot => {
    const unreadMsgs = getUnreadMessagesForBot(bot.id);
    const previewPayload = buildIncrementalPayload(bot.id);
    return /*#__PURE__*/React.createElement("div", {
      key: bot.id,
      className: `rounded-3xl p-5 border transition-all space-y-3.5 ${editingBot?.id === bot.id ? 'ring-2 ring-[#007AFF]/50 border-[#007AFF]' : darkMode ? 'bg-white/[0.03] border-white/[0.08]' : 'bg-white border-zinc-200/80 shadow-xs'}`
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex items-center justify-between"
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex items-center gap-3"
    }, renderEntityAvatar(bot, 'w-10 h-10', 'text-xs'), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("input", {
      type: "text",
      value: bot.name,
      onChange: e => setBots(bs => bs.map(b => b.id === bot.id ? {
        ...b,
        name: e.target.value
      } : b)),
      className: `text-sm font-bold px-2 py-0.5 rounded-lg border focus:outline-none ${darkMode ? 'bg-white/5 border-white/10 text-white' : 'bg-zinc-50 border-zinc-200 text-zinc-900'}`
    }), /*#__PURE__*/React.createElement("div", {
      className: "text-[11px] opacity-50 mt-0.5"
    }, bot.platform, " \xB7 ", bot.roleTag))), /*#__PURE__*/React.createElement("div", {
      className: "flex items-center gap-1.5"
    }, /*#__PURE__*/React.createElement("button", {
      onClick: () => setPersonaEditorBotId(bot.id),
      title: `编辑 ${bot.name} 的人设与身份`,
      className: `px-2.5 py-1 rounded-full text-[11px] font-medium inline-flex items-center gap-1 transition-colors ${darkMode ? 'bg-white/10 hover:bg-white/15 text-zinc-200' : 'bg-zinc-100 hover:bg-zinc-200 text-zinc-700'}`
    }, /*#__PURE__*/React.createElement(Pencil, {
      className: "w-3 h-3"
    }), /*#__PURE__*/React.createElement("span", null, "\u4EBA\u8BBE")), /*#__PURE__*/React.createElement("span", {
      className: `text-[11px] px-2.5 py-1 rounded-full font-mono font-medium ${darkMode ? 'bg-blue-500/15 text-blue-300' : 'bg-blue-50 text-blue-600'}`
    }, "\u6E38\u6807 #", getCursorForBot(bot.id), "/", messages.length), /*#__PURE__*/React.createElement("button", {
      onClick: () => setConfirmModalState({
        title: `移除聊天人「${bot.name}」`,
        message: `确定要从当前列表中移除「${bot.name}」吗？`,
        onConfirm: () => removeBot(bot.id)
      }),
      title: "\u79FB\u9664\u804A\u5929\u4EBA",
      className: "p-1.5 rounded-lg text-rose-500 opacity-70 hover:opacity-100 hover:bg-rose-500/10"
    }, /*#__PURE__*/React.createElement(Trash2, {
      className: "w-3.5 h-3.5"
    })))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
      className: "block text-[11px] font-medium opacity-60 mb-1"
    }, "\u6307\u5B9A\u7F51\u9875\u5BF9\u8BDD URL (\u7CBE\u786E\u5230\u5177\u4F53\u5BF9\u8BDD ID)\uFF1A"), /*#__PURE__*/React.createElement("input", {
      type: "text",
      value: bot.targetUrl,
      onChange: e => setBots(bs => bs.map(b => b.id === bot.id ? {
        ...b,
        targetUrl: e.target.value
      } : b)),
      className: `w-full text-xs font-mono px-3 py-2 rounded-xl border focus:outline-none ${darkMode ? 'bg-black/40 border-white/10 text-blue-400' : 'bg-zinc-50 border-zinc-200 text-blue-600'}`
    })), /*#__PURE__*/React.createElement("div", {
      className: "grid grid-cols-2 gap-2.5"
    }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
      className: "block text-[10px] opacity-50 mb-1"
    }, "\u8F93\u5165\u6846 DOM \u9009\u62E9\u5668"), /*#__PURE__*/React.createElement("input", {
      type: "text",
      value: bot.selectorInput,
      onChange: e => setBots(bs => bs.map(b => b.id === bot.id ? {
        ...b,
        selectorInput: e.target.value
      } : b)),
      className: `w-full text-[11px] font-mono px-2.5 py-1.5 rounded-xl border ${darkMode ? 'bg-black/40 border-white/10' : 'bg-zinc-50 border-zinc-200'}`
    })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
      className: "block text-[10px] opacity-50 mb-1"
    }, "\u53D1\u9001\u6309\u94AE DOM \u9009\u62E9\u5668"), /*#__PURE__*/React.createElement("input", {
      type: "text",
      value: bot.selectorSend,
      onChange: e => setBots(bs => bs.map(b => b.id === bot.id ? {
        ...b,
        selectorSend: e.target.value
      } : b)),
      className: `w-full text-[11px] font-mono px-2.5 py-1.5 rounded-xl border ${darkMode ? 'bg-black/40 border-white/10' : 'bg-zinc-50 border-zinc-200'}`
    }))), /*#__PURE__*/React.createElement("div", {
      className: "p-3 rounded-2xl bg-zinc-950 text-zinc-200 font-mono text-[11px]"
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex items-center justify-between text-emerald-400 mb-1"
    }, /*#__PURE__*/React.createElement("span", null, "\uD83D\uDCE6 \u4E0B\u6B21\u589E\u91CF\u6CE8\u5165\u9884\u89C8 (", unreadMsgs.length, " \u6761\u672A\u8BFB)"), /*#__PURE__*/React.createElement("button", {
      onClick: () => resetBotCursor(bot.id, activeGroupId),
      className: "text-[10px] text-amber-400 hover:underline"
    }, "\u91CD\u7F6E\u6E38\u6807\u4E3A 0")), /*#__PURE__*/React.createElement("pre", {
      className: "whitespace-pre-wrap text-[10px] text-zinc-400 max-h-24 overflow-y-auto"
    }, previewPayload)));
  })))), !isMinimizedToIsland && activeTab === 'anti-preach' && /*#__PURE__*/React.createElement("div", {
    onClick: () => islandExpanded && setIslandExpanded(false),
    className: "flex-1 overflow-y-auto p-6"
  }, /*#__PURE__*/React.createElement("div", {
    className: "max-w-4xl mx-auto space-y-5"
  }, /*#__PURE__*/React.createElement("div", {
    className: "space-y-3"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h2", {
    className: "text-base font-extrabold tracking-tight flex items-center gap-2"
  }, /*#__PURE__*/React.createElement(Sparkles, {
    className: "w-4 h-4 text-amber-500"
  }), /*#__PURE__*/React.createElement("span", null, "\u53BB\u8BF4\u6559\u4E0E\u771F\u4EBA\u7F51\u611F\u8C03\u4F18\u4E2D\u5FC3")), /*#__PURE__*/React.createElement("p", {
    className: "text-xs opacity-65 mt-1"
  }, "\u5F7B\u5E95\u5E72\u6389\u7F51\u9875\u7AEF AI \u5E38\u89C1\u7684\u300C\u9996\u5148\u3001\u5176\u6B21\u3001\u7EFC\u4E0A\u6240\u8FF0\u300D\u548C\u673A\u68B0\u5206\u70B9\u5217\u8868\u3002\u70B9\u51FB\u53F3\u4FA7\u6BDB\u73BB\u7483\u9F7F\u8F6E\u53EF\u6253\u5F00\u5B8C\u6574\u7CFB\u7EDF\u8BBE\u7F6E\u3002")), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-between gap-2 pt-1 pb-1"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-1.5"
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => setActiveTab('sync'),
    className: `px-3 py-1.5 rounded-full text-xs font-semibold border ${darkMode ? 'bg-white/5 border-white/10 text-zinc-300' : 'bg-white/80 border-zinc-200 text-zinc-700'}`
  }, "\uD83D\uDD17 \u7F51\u9875\u7ED1\u5B9A"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => setActiveTab('anti-preach'),
    className: "px-3 py-1.5 rounded-full text-xs font-semibold bg-[#007AFF] text-white border border-[#007AFF]"
  }, "\uD83C\uDFAD \u53BB\u8BF4\u6559\u4E0E\u4EBA\u8BBE\u5E93")), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2 pr-2 shrink-0"
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => setSystemSettingsOpen(true),
    title: "\u6253\u5F00\u5B8C\u6574\u7CFB\u7EDF\u8BBE\u7F6E\u4E2D\u5FC3",
    className: `w-12 h-12 rounded-full backdrop-blur-2xl border flex items-center justify-center transition-all active:scale-90 ${darkMode ? 'bg-zinc-900/65 border-white/25 text-blue-400 shadow-[0_10px_28px_rgba(0,0,0,0.45),inset_0_1px_2px_rgba(255,255,255,0.25)]' : 'bg-white/70 border-white/95 text-[#007AFF] shadow-[0_10px_28px_rgba(0,122,255,0.20),inset_0_1px_2px_rgba(255,255,255,0.98)]'}`
  }, /*#__PURE__*/React.createElement(Settings, {
    className: "w-6 h-6"
  }))))), /*#__PURE__*/React.createElement("div", {
    className: `p-5 rounded-3xl border space-y-2.5 ${darkMode ? 'bg-blue-500/10 border-blue-500/20' : 'bg-blue-50/70 border-blue-200/80'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-between"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-xs font-bold"
  }, "\u5168\u5C40\u589E\u91CF\u6D88\u606F\u540E\u7F00\uFF08\u6BCF\u6B21\u53D1\u5F80\u7F51\u9875\u8F93\u5165\u6846\u65F6\u81EA\u52A8\u9644\u5E26\uFF09"), /*#__PURE__*/React.createElement("span", {
    className: "text-[11px] text-blue-500 font-medium"
  }, "\u5B9E\u65F6\u751F\u6548")), /*#__PURE__*/React.createElement("textarea", {
    value: antiPreachSuffix,
    onChange: e => setAntiPreachSuffix(e.target.value),
    rows: 2,
    className: `w-full p-3 text-xs rounded-2xl border focus:outline-none ${darkMode ? 'bg-black/40 border-white/10 text-zinc-100' : 'bg-white border-blue-200 text-zinc-800'}`
  })), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-1 md:grid-cols-2 gap-4"
  }, bots.map(bot => {
    const initPrompt = `【群聊入群设定协议】
从现在起，我们在这个网页对话里进行一场真实的微信群聊。
你的群昵称和身份是：【${bot.name}（${bot.roleTag}）】
你的人设性格：${bot.persona}

每次我会把你没看过的最新群消息按 [发送人]: 内容 的格式同步给你。
⚠️ 铁律：
1. 严禁使用“首先、其次、总之”或 1. 2. 3. 列表符号！
2. 严禁说教、严禁端着架子当客服！
3. 每次回复控制在 1~2 句话（50字以内），直接输出回复正文，不要带名字前缀。`;
    return /*#__PURE__*/React.createElement("div", {
      key: bot.id,
      className: `p-5 rounded-3xl border space-y-3 ${darkMode ? 'bg-white/[0.03] border-white/[0.08]' : 'bg-white border-zinc-200/80 shadow-xs'}`
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex items-center justify-between"
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex items-center gap-2"
    }, renderEntityAvatar(bot, 'w-6 h-6', 'text-[10px]'), /*#__PURE__*/React.createElement("span", {
      className: "text-xs font-bold"
    }, bot.name, " \u9996\u53E5\u5165\u7FA4\u534F\u8BAE")), /*#__PURE__*/React.createElement("button", {
      onClick: () => handleCopy(initPrompt, `init-${bot.id}`),
      className: "px-3 py-1 rounded-full bg-[#007AFF] hover:bg-blue-600 text-white text-[11px] font-medium flex items-center gap-1"
    }, copiedKey === `init-${bot.id}` ? /*#__PURE__*/React.createElement(Check, {
      className: "w-3 h-3"
    }) : /*#__PURE__*/React.createElement(Copy, {
      className: "w-3 h-3"
    }), /*#__PURE__*/React.createElement("span", null, "\u590D\u5236\u53D1\u5230\u7F51\u9875"))), /*#__PURE__*/React.createElement("textarea", {
      value: bot.persona,
      onChange: e => setBots(bs => bs.map(b => b.id === bot.id ? {
        ...b,
        persona: e.target.value
      } : b)),
      rows: 2,
      className: `w-full text-[11px] p-2.5 rounded-xl border ${darkMode ? 'bg-black/40 border-white/10 text-zinc-300' : 'bg-zinc-50 border-zinc-200 text-zinc-700'}`
    }), /*#__PURE__*/React.createElement("pre", {
      className: "text-[10px] bg-zinc-950 text-zinc-300 p-3 rounded-2xl max-h-28 overflow-y-auto whitespace-pre-wrap font-mono"
    }, initPrompt));
  })))), !isMinimizedToIsland && activeTab === 'bridge' && /*#__PURE__*/React.createElement("div", {
    onClick: () => islandExpanded && setIslandExpanded(false),
    className: "flex-1 overflow-y-auto p-6"
  }, /*#__PURE__*/React.createElement("div", {
    className: "max-w-4xl mx-auto space-y-5"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap items-center justify-between gap-3"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h2", {
    className: "text-lg font-bold tracking-tight flex items-center gap-2"
  }, /*#__PURE__*/React.createElement(Terminal, {
    className: "w-5 h-5 text-emerald-500"
  }), "\u624B\u673A\u5185\u5D4C WebView \u5185\u5B58\u76F4\u8FDE\u6865 & \u8DE8\u7AEF\u6865\u63A5\u4E2D\u5FC3"), /*#__PURE__*/React.createElement("p", {
    className: "text-xs opacity-60 mt-0.5"
  }, "\u5B89\u5353\u624B\u673A\u7248\u9ED8\u8BA4\u542F\u7528\u300C\u5E94\u7528\u5185\u5D4C\u591A\u6807\u7B7E WebView \u5185\u5B58\u76F4\u8FDE\u300D\uFF08\u65E0\u9700\u5916\u90E8\u7535\u8111\u6216\u7AEF\u53E3\uFF09\uFF1B\u4E5F\u652F\u6301\u4E00\u952E\u5207\u6362\u5230\u5C40\u57DF\u7F51 WebSocket \u6865\u63A5\u3002")), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2"
  }, /*#__PURE__*/React.createElement("input", {
    type: "text",
    value: wsUrl,
    onChange: e => setWsUrl(e.target.value),
    className: `text-xs font-mono px-3 py-1.5 rounded-xl border ${darkMode ? 'bg-black/40 border-white/10' : 'bg-white border-zinc-200'}`
  }), /*#__PURE__*/React.createElement("button", {
    onClick: connectLocalBridge,
    className: "px-3.5 py-1.5 rounded-xl bg-[#007AFF] hover:bg-blue-600 text-white text-xs font-medium flex items-center gap-1.5"
  }, /*#__PURE__*/React.createElement(RefreshCw, {
    className: "w-3.5 h-3.5"
  }), /*#__PURE__*/React.createElement("span", null, "\u8FDE\u63A5\u672C\u5730\u6865\u63A5\u670D\u52A1")))), /*#__PURE__*/React.createElement("div", {
    className: `p-5 rounded-3xl border space-y-3.5 ${darkMode ? 'bg-emerald-950/20 border-emerald-500/30' : 'bg-emerald-50/70 border-emerald-200'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap items-center justify-between gap-2"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "text-sm font-bold flex items-center gap-2"
  }, /*#__PURE__*/React.createElement(Smartphone, {
    className: "w-4 h-4 text-emerald-500"
  }), /*#__PURE__*/React.createElement("span", null, "\u9009\u62E9\u624B\u673A\u7AEF\u7F51\u9875\u8FDE\u63A5\u65B9\u5F0F\uFF08\u63A8\u8350\u4F7F\u7528\u65B9\u6848 1\uFF1A\u5E94\u7528\u5185\u5D4C WebView \u76F4\u8FDE\uFF09")), /*#__PURE__*/React.createElement("p", {
    className: "text-[11px] opacity-65 mt-0.5"
  }, "\u65B9\u6848 1 \u76F4\u63A5\u628A\u5404\u5BB6 AI \u7F51\u9875\u4F5C\u4E3A\u591A\u6807\u7B7E WebView \u5D4C\u5957\u5728\u672C\u5E94\u7528\u5185\uFF0C\u901A\u8FC7 ", /*#__PURE__*/React.createElement("code", {
    className: "font-mono"
  }, "evaluateJavascript"), " + ", /*#__PURE__*/React.createElement("code", {
    className: "font-mono"
  }, "AndroidWebHBridge"), " \u5185\u5B58\u901A\u4FE1\uFF0C\u96F6\u5EF6\u8FDF\u4E14\u5F7B\u5E95\u4FEE\u590D\u4E86 ChatGPT \u5386\u53F2\u6D88\u606F\u62FC\u63A5\u95EE\u9898\u3002"))), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-1 sm:grid-cols-2 gap-3"
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => {
      setBridgeTransportMode('in-app-webview');
      showToast('已切换为「应用内嵌多标签 WebView 内存直连」');
    },
    className: `p-3.5 rounded-2xl border text-left transition-all ${bridgeTransportMode === 'in-app-webview' ? 'bg-emerald-600 border-emerald-600 text-white shadow-md' : darkMode ? 'bg-black/30 border-white/10 hover:bg-white/5' : 'bg-white border-zinc-200 hover:bg-zinc-50'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-xs font-bold flex items-center justify-between"
  }, /*#__PURE__*/React.createElement("span", null, "\uD83D\uDCF1 \u65B9\u6848 1\uFF1A\u5E94\u7528\u5185\u5D4C\u591A\u6807\u7B7E WebView \u76F4\u8FDE\uFF08\u624B\u673A\u9996\u9009\uFF09"), bridgeTransportMode === 'in-app-webview' && /*#__PURE__*/React.createElement("span", {
    className: "text-[10px] px-2 py-0.5 rounded-full bg-white/20"
  }, "\u5F53\u524D\u4F7F\u7528\u4E2D")), /*#__PURE__*/React.createElement("div", {
    className: `text-[10px] mt-1 leading-relaxed ${bridgeTransportMode === 'in-app-webview' ? 'text-white/90' : 'opacity-65'}`
  }, "\u6240\u6709 AI \u7F51\u9875\u76F4\u63A5\u5D4C\u5957\u5728 App \u5185\uFF08\u300C\uD83C\uDF10 \u5185\u5D4C\u7F51\u9875\u300D\u4E0E\u300C\u540C\u5C4F\u5206\u5C4F\u300D\uFF09\uFF0C\u65E0\u9700\u7535\u8111\u3001\u65E0\u9700\u914D IP \u7AEF\u53E3\uFF0C\u624B\u673A\u72EC\u7ACB\u8FD0\u884C\u3002")), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => {
      setBridgeTransportMode('lan-ws');
      showToast('已切换为「局域网 / 本地 WebSocket 桥接模式」');
    },
    className: `p-3.5 rounded-2xl border text-left transition-all ${bridgeTransportMode === 'lan-ws' ? 'bg-[#007AFF] border-[#007AFF] text-white shadow-md' : darkMode ? 'bg-black/30 border-white/10 hover:bg-white/5' : 'bg-white border-zinc-200 hover:bg-zinc-50'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-xs font-bold flex items-center justify-between"
  }, /*#__PURE__*/React.createElement("span", null, "\uD83D\uDCE1 \u65B9\u6848 2\uFF1A\u5C40\u57DF\u7F51 / PC WebSocket \u6865\u63A5 (`ws://...`)"), bridgeTransportMode === 'lan-ws' && /*#__PURE__*/React.createElement("span", {
    className: "text-[10px] px-2 py-0.5 rounded-full bg-white/20"
  }, "\u5F53\u524D\u4F7F\u7528\u4E2D")), /*#__PURE__*/React.createElement("div", {
    className: `text-[10px] mt-1 leading-relaxed ${bridgeTransportMode === 'lan-ws' ? 'text-white/90' : 'opacity-65'}`
  }, "\u624B\u673A\u901A\u8FC7\u5C40\u57DF\u7F51\u8FDE\u63A5\u7535\u8111\u7AEF `bridge.js` (\u5982 `ws://192.168.1.x:8765`) \u6216\u624B\u673A Termux \u540E\u53F0\u670D\u52A1\u3002")))), /*#__PURE__*/React.createElement("div", {
    className: `p-5 rounded-3xl border space-y-3 ${darkMode ? 'bg-white/[0.03] border-white/[0.08]' : 'bg-white border-zinc-200/80 shadow-xs'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-between"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-xs font-bold"
  }, "\uD83D\uDCF1 \u5B89\u5353\u539F\u751F\u5185\u5D4C\u591A\u6807\u7B7E WebView \u5BBF\u4E3B\u4E0E JS \u6CE8\u5165\u6865\u6E90\u7801 (`MainActivity.kt` + `web_h_injector.js`)"), /*#__PURE__*/React.createElement("button", {
    onClick: () => handleCopy(ANDROID_NATIVE_BRIDGE_SOURCE, 'android-native-code'),
    className: "px-3 py-1 rounded-full bg-[#007AFF] text-white text-xs font-medium flex items-center gap-1.5"
  }, copiedKey === 'android-native-code' ? /*#__PURE__*/React.createElement(Check, {
    className: "w-3.5 h-3.5 text-white"
  }) : /*#__PURE__*/React.createElement(Copy, {
    className: "w-3.5 h-3.5"
  }), /*#__PURE__*/React.createElement("span", null, "\u590D\u5236\u5B89\u5353\u539F\u751F\u6865\u63A5\u6E90\u7801"))), /*#__PURE__*/React.createElement("pre", {
    className: "p-4 rounded-2xl bg-zinc-950 text-cyan-300 text-[11px] font-mono overflow-x-auto max-h-64 leading-relaxed"
  }, ANDROID_NATIVE_BRIDGE_SOURCE)), /*#__PURE__*/React.createElement("div", {
    className: `p-5 rounded-3xl border space-y-3 ${darkMode ? 'bg-white/[0.03] border-white/[0.08]' : 'bg-white border-zinc-200/80 shadow-xs'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-between"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-xs font-bold"
  }, "\u65B9\u6848 A\uFF1APlaywright \u63A5\u7BA1\u672C\u5730 Chrome (`bridge.js`)"), /*#__PURE__*/React.createElement("button", {
    onClick: () => handleCopy(generatePlaywrightCode(), 'pw-code'),
    className: "px-3 py-1 rounded-full bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 text-xs font-medium flex items-center gap-1.5"
  }, copiedKey === 'pw-code' ? /*#__PURE__*/React.createElement(Check, {
    className: "w-3.5 h-3.5 text-emerald-400"
  }) : /*#__PURE__*/React.createElement(Copy, {
    className: "w-3.5 h-3.5"
  }), /*#__PURE__*/React.createElement("span", null, "\u590D\u5236\u5B8C\u6574\u811A\u672C"))), /*#__PURE__*/React.createElement("pre", {
    className: "p-4 rounded-2xl bg-zinc-950 text-emerald-300 text-[11px] font-mono overflow-x-auto max-h-64 leading-relaxed"
  }, generatePlaywrightCode())), /*#__PURE__*/React.createElement("div", {
    className: `p-5 rounded-3xl border space-y-3 ${darkMode ? 'bg-white/[0.03] border-white/[0.08]' : 'bg-white border-zinc-200/80 shadow-xs'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-between"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-xs font-bold"
  }, "\u6CB9\u7334\u517C\u5BB9\u6027\u8BF4\u660E"), /*#__PURE__*/React.createElement("button", {
    onClick: () => handleCopy(generateUserscriptCode(), 'tm-code'),
    className: "px-3 py-1 rounded-full bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 text-xs font-medium flex items-center gap-1.5"
  }, copiedKey === 'tm-code' ? /*#__PURE__*/React.createElement(Check, {
    className: "w-3.5 h-3.5 text-emerald-400"
  }) : /*#__PURE__*/React.createElement(Copy, {
    className: "w-3.5 h-3.5"
  }), /*#__PURE__*/React.createElement("span", null, "\u590D\u5236\u8BF4\u660E"))), /*#__PURE__*/React.createElement("pre", {
    className: "p-4 rounded-2xl bg-zinc-950 text-blue-300 text-[11px] font-mono overflow-x-auto max-h-52 leading-relaxed"
  }, generateUserscriptCode())))), !isMinimizedToIsland && activeTab === 'settings' && /*#__PURE__*/React.createElement("div", {
    onClick: () => islandExpanded && setIslandExpanded(false),
    className: "flex-1 flex flex-col min-h-0 overflow-hidden"
  }, /*#__PURE__*/React.createElement("div", {
    className: `shrink-0 z-20 px-3.5 pt-1.5 pb-2 border-b backdrop-blur-2xl ${darkMode ? 'bg-zinc-950/80 border-white/10' : 'bg-white/80 border-zinc-200/80'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "max-w-3xl mx-auto space-y-1.5"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-between gap-1.5"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-1 overflow-x-auto no-scrollbar"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-[10px] font-semibold opacity-55 shrink-0 mr-0.5"
  }, "\u9884\u89C8\u89D2\u8272:"), bots.map(b => {
    const isSelected = selectedBubbleBotId === b.id;
    return /*#__PURE__*/React.createElement("button", {
      key: b.id,
      type: "button",
      onClick: () => {
        setSelectedBubbleBotId(b.id);
        setSelectedAvatarTarget(b.id);
      },
      className: `px-2 py-0.5 rounded-full text-[10px] font-semibold flex items-center gap-1 shrink-0 transition-all ${isSelected ? 'bg-[#007AFF] text-white shadow-2xs' : darkMode ? 'bg-white/5 text-zinc-300' : 'bg-zinc-100 text-zinc-700'}`
    }, renderEntityAvatar(b, 'w-3.5 h-3.5', 'text-[7px]', true), /*#__PURE__*/React.createElement("span", null, b.name.split(' ')[0]));
  })), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: handleResetAppearance,
    className: `px-2 py-0.5 rounded-full border text-[10px] font-medium shrink-0 flex items-center gap-1 ${darkMode ? 'bg-white/5 border-white/10 text-zinc-300' : 'bg-zinc-100 border-zinc-200 text-zinc-600'}`
  }, /*#__PURE__*/React.createElement(RotateCcw, {
    className: "w-2.5 h-2.5"
  }), /*#__PURE__*/React.createElement("span", null, "\u91CD\u7F6E"))), (() => {
    const activePreviewBot = bots.find(b => b.id === selectedBubbleBotId) || bots[0];
    const activePreviewStyle = BUBBLE_STYLES.find(s => s.id === activePreviewBot?.bubbleStyleId) || currentBubbleStyle;
    return /*#__PURE__*/React.createElement("div", {
      className: `px-3 py-2 rounded-2xl border space-y-1.5 ${darkMode ? 'bg-zinc-900/75 border-white/10' : 'bg-zinc-50/90 border-zinc-200/80'}`
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex items-center gap-2 justify-start"
    }, renderEntityAvatar(activePreviewBot, 'w-6 h-6', 'text-[9px]', true), /*#__PURE__*/React.createElement("div", {
      style: getBotBubbleInlineStyle(activePreviewBot),
      className: `px-2.5 py-1 text-[11px] truncate max-w-[82%] ${activePreviewStyle.botRadius} ${getBotBubbleClasses(activePreviewBot)}`
    }, activePreviewBot.name.split(' ')[0], "\uFF1A\u8FD9\u662F\u6211\u7684\u4E13\u5C5E\u6C14\u6CE1\u4E3B\u9898\u4E0E\u5B57\u53F7\u5B9E\u65F6\u9884\u89C8 \u2728")), /*#__PURE__*/React.createElement("div", {
      className: "flex items-center gap-2 justify-end"
    }, /*#__PURE__*/React.createElement("div", {
      style: myBubbleColorId === 'custom' ? {
        backgroundColor: myBubbleCustomBg,
        color: myBubbleCustomText
      } : {
        background: currentMyBubbleColor.swatch,
        color: myBubbleColorId === 'wechat-green' ? '#18181b' : '#ffffff'
      },
      className: `px-2.5 py-1 text-[11px] truncate max-w-[82%] ${currentBubbleStyle.meRadius} ${currentMyBubbleColor.className}`
    }, myProfile.name.split(' ')[0], "\uFF1A\u6211\u7684\u6C14\u6CE1\u914D\u8272\u4E0E\u5706\u89D2\u9884\u89C8\uFF0C\u6240\u89C1\u5373\u6240\u5F97"), renderEntityAvatar('me', 'w-6 h-6', 'text-[9px]', true)));
  })())), /*#__PURE__*/React.createElement("div", {
    className: "flex-1 overflow-y-auto px-5 sm:px-7 py-5"
  }, /*#__PURE__*/React.createElement("div", {
    className: "max-w-4xl mx-auto space-y-6 pb-8"
  }, /*#__PURE__*/React.createElement("div", {
    className: `p-4 rounded-3xl border space-y-4 backdrop-blur-2xl ${isLightDopamineTheme ? 'bg-white/95 border-black/10 text-zinc-900 shadow-md' : darkMode ? 'bg-zinc-900/65 border-white/10 text-zinc-100' : 'bg-white/85 border-zinc-200/80 text-zinc-900 shadow-xs'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-between gap-2"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h3", {
    className: "text-sm font-bold flex items-center gap-2"
  }, /*#__PURE__*/React.createElement("span", null, "\u2728 \u82F9\u679C\u6DB2\u6001\u73BB\u7483\u8D28\u611F \xB7 \u7FA4\u4E0E\u6E38\u6807\u53CA\u5206\u7FA4\u804A\u80CC\u666F\u8BBE\u7F6E")), /*#__PURE__*/React.createElement("p", {
    className: "text-[10px] opacity-75 mt-0.5"
  }, "\u590D\u523B iOS \u9AD8\u900F\u6DB2\u6001\u73BB\u7483\u5F27\u9762\u6298\u5C04\u4E0E\u8FB9\u7F18\u9AD8\u5149\uFF0C\u652F\u6301\u81EA\u7531\u8C03\u8282\u8D28\u611F\u5F3A\u5EA6\uFF0C\u5E76\u53EF\u5206\u522B\u66F4\u6362\u300C\u7FA4\u4E0E\u6E38\u6807\u300D\u4E3B\u9875\u80CC\u666F\u53CA\u6BCF\u4E2A\u300C\u7FA4\u804A\u300D\u7684\u72EC\u7ACB\u804A\u5929\u80CC\u666F\u56FE\u3002")), /*#__PURE__*/React.createElement("span", {
    className: "text-[10px] px-2.5 py-0.5 rounded-full bg-blue-500/15 text-[#007AFF] font-bold shrink-0"
  }, "Liquid Glass")), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-1 gap-3 text-xs"
  }, /*#__PURE__*/React.createElement("label", {
    className: `p-3.5 rounded-2xl border flex flex-col gap-1.5 ${isLightDopamineTheme ? 'bg-white/85 border-black/10 text-zinc-900' : darkMode ? 'bg-black/30 border-white/10 text-zinc-200' : 'bg-zinc-50 border-zinc-200/70 text-zinc-900'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex justify-between font-semibold"
  }, /*#__PURE__*/React.createElement("span", null, "\u6DB2\u6001\u73BB\u7483\u6298\u5C04\u4E0E\u5F27\u9762\u9AD8\u5149\u7A0B\u5EA6"), /*#__PURE__*/React.createElement("span", {
    className: "font-mono text-[#007AFF]"
  }, liquidGlassLevel, "%")), /*#__PURE__*/React.createElement("input", {
    type: "range",
    min: "0",
    max: "100",
    value: liquidGlassLevel,
    onChange: e => setLiquidGlassLevel(Number(e.target.value)),
    className: "w-full accent-blue-500"
  }))), /*#__PURE__*/React.createElement("div", {
    className: "pt-2 border-t border-current/10 space-y-2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-between"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-xs font-bold"
  }, "\uD83D\uDDBC\uFE0F \u66F4\u6362\u300C\u7FA4\u4E0E\u6E38\u6807\u300D\u4E3B\u9875\u80CC\u666F\uFF08\u9ED8\u8BA4\uFF1A\u6700\u8FD1\u804A\u5929\u754C\u9762\uFF09"), /*#__PURE__*/React.createElement("input", {
    ref: groupsBgFileInputRef,
    type: "file",
    accept: "image/*",
    onChange: handleUploadGroupsBgFile,
    className: "hidden"
  }), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => groupsBgFileInputRef.current && groupsBgFileInputRef.current.click(),
    className: "px-2.5 py-1 rounded-xl bg-[#007AFF]/15 text-[#007AFF] text-[11px] font-bold flex items-center gap-1"
  }, /*#__PURE__*/React.createElement(Upload, {
    className: "w-3 h-3"
  }), /*#__PURE__*/React.createElement("span", null, "\u4E0A\u4F20\u624B\u673A\u80CC\u666F\u56FE"))), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-2 sm:grid-cols-4 gap-2"
  }, [{
    id: 'recent-chat',
    label: '最近退出的聊天界面'
  }, {
    id: 'rain-city',
    label: '雨夜都市窗景'
  }, {
    id: 'ocean-aurora',
    label: '深海流光极光'
  }, {
    id: 'neon-night',
    label: '霓虹暮光都市'
  }].map(bgOpt => /*#__PURE__*/React.createElement("button", {
    key: bgOpt.id,
    type: "button",
    onClick: () => setGroupsBgMode(bgOpt.id),
    className: `py-2 px-2.5 rounded-2xl border text-xs font-semibold truncate transition-all ${groupsBgMode === bgOpt.id ? 'bg-[#007AFF] text-white border-[#007AFF] shadow-xs' : darkMode ? 'bg-black/30 border-white/10 text-zinc-300' : 'bg-zinc-50 border-zinc-200 text-zinc-700'}`
  }, bgOpt.label)))), /*#__PURE__*/React.createElement("div", {
    className: "pt-2 border-t border-current/10 space-y-2.5"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap items-center justify-between gap-2"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-xs font-bold"
  }, "\uD83D\uDCAC \u66F4\u6362\u4E0D\u540C\u7FA4\u804A\u7684\u804A\u5929\u80CC\u666F\u56FE & \u6DB2\u6001\u73BB\u7483\u6548\u679C\uFF1A"), /*#__PURE__*/React.createElement("input", {
    ref: chatBgFileInputRef,
    type: "file",
    accept: "image/*",
    onChange: handleUploadGroupChatBgFile,
    className: "hidden"
  }), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => chatBgFileInputRef.current && chatBgFileInputRef.current.click(),
    className: "px-2.5 py-1 rounded-xl bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 text-[11px] font-bold flex items-center gap-1"
  }, /*#__PURE__*/React.createElement(Upload, {
    className: "w-3 h-3"
  }), /*#__PURE__*/React.createElement("span", null, "\u4E0A\u4F20\u8BE5\u7FA4\u4E13\u5C5E\u80CC\u666F\u56FE"))), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-1.5 overflow-x-auto no-scrollbar"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-[11px] opacity-65 shrink-0"
  }, "\u9009\u62E9\u7FA4\u804A:"), groups.map(grp => /*#__PURE__*/React.createElement("button", {
    key: grp.id,
    type: "button",
    onClick: () => setSelectedWallpaperGroupId(grp.id),
    className: `px-3 py-1 rounded-full text-xs font-bold shrink-0 border transition-all ${selectedWallpaperGroupId === grp.id ? 'bg-[#007AFF] text-white border-[#007AFF]' : darkMode ? 'bg-white/5 border-white/10 text-zinc-300' : 'bg-zinc-100 border-zinc-200 text-zinc-700'}`
  }, grp.name))), (() => {
    const curGid = selectedWallpaperGroupId || activeGroupId;
    const curCfg = groupWallpapers[curGid] || {
      bgMode: 'default',
      liquidEnabled: true
    };
    const curLiq = curCfg.liquidEnabled !== false;
    return /*#__PURE__*/React.createElement("div", {
      className: "space-y-2"
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex items-center justify-between text-xs px-1"
    }, /*#__PURE__*/React.createElement("span", {
      className: "opacity-75"
    }, "\u5F53\u524D\u9009\u4E2D\u7FA4\u804A\u6DB2\u6001\u73BB\u7483\u80CC\u666F\uFF1A"), /*#__PURE__*/React.createElement("button", {
      type: "button",
      onClick: () => setGroupWallpapers(prev => ({
        ...prev,
        [curGid]: {
          ...curCfg,
          liquidEnabled: !curLiq
        }
      })),
      className: `px-3 py-1 rounded-full text-[11px] font-bold ${curLiq ? 'bg-emerald-500 text-white' : 'bg-zinc-500/20 text-zinc-400'}`
    }, curLiq ? '✨ 本群液态玻璃已开启' : '本群液态玻璃已关闭')), /*#__PURE__*/React.createElement("div", {
      className: "grid grid-cols-2 sm:grid-cols-5 gap-2"
    }, [{
      id: 'default',
      label: '跟随全局主题'
    }, {
      id: 'rain-city',
      label: '雨夜都市窗景'
    }, {
      id: 'ocean-aurora',
      label: '深海极光水幕'
    }, {
      id: 'neon-night',
      label: '霓虹暮光都市'
    }, {
      id: 'emerald-dew',
      label: '翡翠晨光森林'
    }].map(opt => /*#__PURE__*/React.createElement("button", {
      key: opt.id,
      type: "button",
      onClick: () => setGroupWallpapers(prev => ({
        ...prev,
        [curGid]: {
          ...curCfg,
          bgMode: opt.id,
          liquidEnabled: true
        }
      })),
      className: `py-2 px-2 rounded-2xl border text-xs font-semibold truncate transition-all ${(curCfg.bgMode || 'default') === opt.id ? 'bg-[#007AFF] text-white border-[#007AFF]' : darkMode ? 'bg-black/30 border-white/10 text-zinc-300' : 'bg-zinc-50 border-zinc-200 text-zinc-700'}`
    }, opt.label))));
  })())), /*#__PURE__*/React.createElement("div", {
    className: `p-4 rounded-3xl border space-y-4 backdrop-blur-2xl ${darkMode ? 'bg-zinc-900/65 border-white/10' : 'bg-white/85 border-zinc-200/80 shadow-xs'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-between"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "text-sm font-bold flex items-center gap-2"
  }, /*#__PURE__*/React.createElement("span", null, "\uD83D\uDCD0 \u7075\u52A8\u5C9B\u5C3A\u5BF8\uFF08\u6700\u9AD8 75px \u5305\u88F9\u6444\u50CF\u5934\uFF09\u3001\u547C\u5438\u5149\u6655\u4E0E\u5706\u94AE\u8C03\u8282")), /*#__PURE__*/React.createElement("span", {
    className: "text-[10px] px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-500 font-mono"
  }, "\u6444\u50CF\u5934\u81EA\u9002\u5E94\u5305\u88F9")), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs"
  }, /*#__PURE__*/React.createElement("label", {
    className: `p-3 rounded-2xl border flex flex-col gap-1.5 ${isLightDopamineTheme ? 'bg-white/85 border-black/10 text-zinc-900' : darkMode ? 'bg-black/30 border-white/10 text-zinc-200' : 'bg-zinc-50 border-zinc-200/70 text-zinc-900'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex justify-between font-semibold"
  }, /*#__PURE__*/React.createElement("span", null, "\u8DDD\u79BB\u5C4F\u5E55\u9876\u90E8\u8DDD\u79BB"), /*#__PURE__*/React.createElement("span", {
    className: "font-mono text-blue-500"
  }, islandTopOffset, " px")), /*#__PURE__*/React.createElement("input", {
    type: "range",
    min: "0",
    max: "64",
    value: islandTopOffset,
    onChange: e => setIslandTopOffset(Number(e.target.value)),
    className: "w-full accent-blue-500"
  })), /*#__PURE__*/React.createElement("label", {
    className: `p-3 rounded-2xl border flex flex-col gap-1.5 ${isLightDopamineTheme ? 'bg-white/85 border-black/10 text-zinc-900' : darkMode ? 'bg-black/30 border-white/10 text-zinc-200' : 'bg-zinc-50 border-zinc-200/70 text-zinc-900'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex justify-between font-semibold"
  }, /*#__PURE__*/React.createElement("span", null, "\u7075\u52A8\u5C9B\u957F\u5EA6 / \u5BBD\u5EA6"), /*#__PURE__*/React.createElement("span", {
    className: "font-mono text-blue-500"
  }, islandWidth, " px")), /*#__PURE__*/React.createElement("input", {
    type: "range",
    min: "180",
    max: "350",
    value: islandWidth,
    onChange: e => setIslandWidth(Number(e.target.value)),
    className: "w-full accent-blue-500"
  })), /*#__PURE__*/React.createElement("label", {
    className: `p-3 rounded-2xl border flex flex-col gap-1.5 ${isLightDopamineTheme ? 'bg-white/85 border-black/10 text-zinc-900' : darkMode ? 'bg-black/30 border-white/10 text-zinc-200' : 'bg-zinc-50 border-zinc-200/70 text-zinc-900'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex justify-between font-semibold"
  }, /*#__PURE__*/React.createElement("span", null, "\u7075\u52A8\u5C9B\u9AD8\u5EA6\uFF08\u6700\u9AD8 75px \u5305\u88F9\u6444\u50CF\u5934\uFF09"), /*#__PURE__*/React.createElement("span", {
    className: "font-mono text-blue-500"
  }, islandHeight, " px")), /*#__PURE__*/React.createElement("input", {
    type: "range",
    min: "30",
    max: "75",
    value: islandHeight,
    onChange: e => setIslandHeight(Number(e.target.value)),
    className: "w-full accent-blue-500"
  })), /*#__PURE__*/React.createElement("label", {
    className: `p-3 rounded-2xl border flex flex-col gap-1.5 ${isLightDopamineTheme ? 'bg-white/85 border-black/10 text-zinc-900' : darkMode ? 'bg-black/30 border-white/10 text-zinc-200' : 'bg-zinc-50 border-zinc-200/70 text-zinc-900'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex justify-between font-semibold"
  }, /*#__PURE__*/React.createElement("span", null, "\u804A\u5929\u53F3\u4E0A\u89D2\u73BB\u7483\u5706\u94AE\u76F4\u5F84"), /*#__PURE__*/React.createElement("span", {
    className: "font-mono text-blue-500"
  }, topActionBtnSize, " px")), /*#__PURE__*/React.createElement("input", {
    type: "range",
    min: "30",
    max: "58",
    value: topActionBtnSize,
    onChange: e => setTopActionBtnSize(Number(e.target.value)),
    className: "w-full accent-blue-500"
  })), /*#__PURE__*/React.createElement("label", {
    className: `p-3 rounded-2xl border flex flex-col gap-1.5 ${isLightDopamineTheme ? 'bg-white/85 border-black/10 text-zinc-900' : darkMode ? 'bg-black/30 border-white/10 text-zinc-200' : 'bg-zinc-50 border-zinc-200/70 text-zinc-900'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex justify-between font-semibold"
  }, /*#__PURE__*/React.createElement("span", null, "\u7075\u52A8\u5C9B\u547C\u5438\u5E45\u5EA6\u660E\u663E\u7A0B\u5EA6"), /*#__PURE__*/React.createElement("span", {
    className: "font-mono text-emerald-500"
  }, islandBreathLevel === 0 ? '已关闭' : `${islandBreathLevel}%`)), /*#__PURE__*/React.createElement("input", {
    type: "range",
    min: "0",
    max: "100",
    value: islandBreathLevel,
    onChange: e => setIslandBreathLevel(Number(e.target.value)),
    className: "w-full accent-emerald-500"
  })), /*#__PURE__*/React.createElement("div", {
    className: `p-3 rounded-2xl border flex items-center justify-between ${isLightDopamineTheme ? 'bg-white/85 border-black/10 text-zinc-900' : darkMode ? 'bg-black/30 border-white/10 text-zinc-200' : 'bg-zinc-50 border-zinc-200/70 text-zinc-900'}`
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "font-semibold"
  }, "\u7075\u52A8\u5C9B\u5468\u56F4\u968F\u8272\u547C\u5438\u5149\u6655"), /*#__PURE__*/React.createElement("div", {
    className: "text-[10px] opacity-60 mt-0.5"
  }, "\u5149\u6655\u989C\u8272\u81EA\u52A8\u8DDF\u968F\u7075\u52A8\u5C9B\u4E3B\u8272\u8C03")), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => setIslandGlowEnabled(v => !v),
    className: `px-3 py-1.5 rounded-full text-xs font-bold transition-all ${islandGlowEnabled ? 'bg-emerald-500 text-white' : 'bg-zinc-500/20 text-zinc-400'}`
  }, islandGlowEnabled ? '光晕已开启' : '光晕已关闭'))), /*#__PURE__*/React.createElement("div", {
    className: "pt-2 border-t border-current/10 space-y-3"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-between"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-xs font-bold"
  }, "\uD83D\uDD24 \u5168\u5C40\u5B57\u4F53\u6B3E\u5F0F\u4E0E\u5B57\u53F7\u5927\u5C0F"), /*#__PURE__*/React.createElement("span", {
    className: "text-[11px] font-mono text-blue-500"
  }, appFontSize, "px")), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-2 sm:grid-cols-4 gap-2"
  }, [{
    id: 'system',
    label: '苹果原生苹方'
  }, {
    id: 'rounded',
    label: '现代柔和圆体'
  }, {
    id: 'serif',
    label: '雅致宋楷书卷'
  }, {
    id: 'mono',
    label: '极客等宽代码'
  }].map(f => /*#__PURE__*/React.createElement("button", {
    key: f.id,
    type: "button",
    onClick: () => setAppFontFamily(f.id),
    className: `py-2 px-2.5 rounded-2xl border text-xs font-semibold transition-all ${appFontFamily === f.id ? 'bg-[#007AFF] text-white border-[#007AFF] shadow-xs' : darkMode ? 'bg-black/30 border-white/10 text-zinc-300' : 'bg-zinc-50 border-zinc-200 text-zinc-700'}`
  }, f.label))), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-3"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-xs opacity-70 shrink-0"
  }, "\u5B57\u4F53\u5927\u5C0F:"), [12, 14, 16, 18].map(sz => /*#__PURE__*/React.createElement("button", {
    key: sz,
    type: "button",
    onClick: () => setAppFontSize(sz),
    className: `px-3 py-1 rounded-xl border text-xs font-semibold ${appFontSize === sz ? 'bg-[#007AFF] text-white border-[#007AFF]' : darkMode ? 'bg-black/30 border-white/10 text-zinc-300' : 'bg-zinc-50 border-zinc-200 text-zinc-700'}`
  }, sz === 12 ? '小(12)' : sz === 14 ? '标准(14)' : sz === 16 ? '大(16)' : '特大(18)'))))), /*#__PURE__*/React.createElement("div", {
    id: "appearance-island",
    className: `scroll-mt-4 p-5 rounded-3xl border space-y-4 ${darkMode ? 'bg-white/[0.03] border-white/[0.08]' : 'bg-white border-zinc-200/80 shadow-xs'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-between"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h3", {
    className: "text-sm font-bold flex items-center gap-2"
  }, /*#__PURE__*/React.createElement("span", null, "\uD83C\uDFDD\uFE0F \u7075\u52A8\u5C9B\u989C\u8272\u4E0E\u6750\u8D28\u98CE\u683C")), /*#__PURE__*/React.createElement("p", {
    className: "text-[11px] opacity-55 mt-0.5"
  }, "\u6240\u6709\u8272\u5361\u5747\u4EE5\u5FAE\u7F29\u7075\u52A8\u5C9B\u80F6\u56CA\u6837\u5F0F\u76F4\u63A5\u5C55\u793A\uFF0C\u70B9\u51FB\u5373\u53EF\u5207\u6362\u9876\u90E8\u7075\u52A8\u5C9B\u914D\u8272\u3002")), /*#__PURE__*/React.createElement("span", {
    className: "text-[11px] px-2.5 py-1 rounded-full bg-blue-500/10 text-blue-500 font-medium"
  }, "\u5F53\u524D\uFF1A", currentIslandPreset.name)), /*#__PURE__*/React.createElement("div", {
    className: `flex flex-wrap items-center justify-between gap-3 p-3.5 rounded-2xl border mb-2.5 ${isLightDopamineTheme ? 'bg-black/[0.04] border-black/10 text-zinc-900' : darkMode ? 'bg-white/[0.03] border-white/10 text-zinc-200' : 'bg-zinc-50 border-zinc-200 text-zinc-900'}`
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "text-xs font-bold flex items-center gap-1.5"
  }, /*#__PURE__*/React.createElement("span", null, "\uD83C\uDF17 \u7075\u52A8\u5C9B\u6444\u50CF\u5934\u5305\u88F9\u6E10\u53D8\u6A21\u5F0F"), /*#__PURE__*/React.createElement("span", {
    className: "text-[10px] px-2 py-0.5 rounded-full bg-indigo-500/15 text-indigo-500 font-semibold"
  }, islandGradientMode === 'basic' ? '基础模式 (从左到右渐变)' : '进阶模式 (从上到下·顶部纯黑裹镜头)')), /*#__PURE__*/React.createElement("div", {
    className: "text-[10px] opacity-65 mt-0.5"
  }, "\u8FDB\u9636\u6A21\u5F0F\u4FDD\u6301\u5404\u4E3B\u9898\u8272\u5F69\u4E0E\u4E09\u6863\u7A0B\u5EA6\u4E0D\u53D8\uFF0C\u5C06\u6E10\u53D8\u6539\u4E3A\u4ECE\u4E0A\u5230\u4E0B\uFF08\u4ECE\u7EAF\u9ED1\u5230\u4E3B\u9898\u8272\uFF09\uFF0C\u4F7F\u6587\u5B57\u4E0A\u65B9\u7684\u7EAF\u9ED1\u533A\u57DF\u5B8C\u7F8E\u5305\u88F9\u524D\u7F6E\u6444\u50CF\u5934\u3002")), /*#__PURE__*/React.createElement("div", {
    className: `flex p-1 rounded-xl border ${darkMode ? 'bg-black/40 border-white/10' : 'bg-white border-zinc-200'} text-[11px] font-semibold shrink-0`
  }, [{
    id: 'basic',
    label: '↔️ 基础模式 (从左到右)'
  }, {
    id: 'advanced',
    label: '⬇️ 进阶模式 (从上黑到下色·裹镜头)'
  }].map(gm => /*#__PURE__*/React.createElement("button", {
    key: gm.id,
    type: "button",
    onClick: () => setIslandGradientMode(gm.id),
    className: `px-3 py-1.5 rounded-lg transition-all ${islandGradientMode === gm.id ? 'bg-[#007AFF] text-white shadow-sm font-bold' : 'opacity-70 hover:opacity-100'}`
  }, gm.label)))), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap items-center justify-between gap-3 p-3.5 rounded-2xl border mb-3 ${darkMode ? 'bg-white/[0.03] border-white/10' : 'bg-zinc-50 border-zinc-200'}"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "text-xs font-bold flex items-center gap-1.5"
  }, /*#__PURE__*/React.createElement("span", null, "\uD83C\uDFA8 \u6E10\u53D8\u8868\u73B0\u7A0B\u5EA6"), /*#__PURE__*/React.createElement("span", {
    className: "text-[10px] px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-500 font-medium font-mono"
  }, islandIntensity === 'subtle' ? '微光内敛 (原版)' : islandIntensity === 'balanced' ? '均衡流光 (黄金比例)' : '绚丽高能 (HDR极光)')), /*#__PURE__*/React.createElement("div", {
    className: "text-[10px] opacity-60 mt-0.5"
  }, "\u539F\u7248\u5185\u655B\u6DF1\u9083\u3001\u9AD8\u80FD\u6D41\u4F53\u6781\u5149\u3001\u6216\u5C45\u4E2D\u5747\u8861\u4F18\u96C5\uFF0C\u4E09\u79CD\u7A0B\u5EA6\u968F\u5FC3\u81EA\u7531\u5207\u6362\u3002")), /*#__PURE__*/React.createElement("div", {
    className: "flex p-1 rounded-xl border ${darkMode ? 'bg-black/40 border-white/10' : 'bg-white border-zinc-200'} text-[11px] font-medium shrink-0"
  }, [{
    id: 'subtle',
    label: '🌱 微光内敛 (原版)'
  }, {
    id: 'balanced',
    label: '✨ 均衡流光 (推荐)'
  }, {
    id: 'vibrant',
    label: '🔥 绚丽高能 (极光)'
  }].map(lvl => /*#__PURE__*/React.createElement("button", {
    key: lvl.id,
    onClick: () => setIslandIntensity(lvl.id),
    className: `px-3 py-1.5 rounded-lg transition-all ${islandIntensity === lvl.id ? 'bg-[#007AFF] text-white shadow-sm font-semibold' : 'opacity-70 hover:opacity-100 hover:bg-black/5 dark:hover:bg-white/10'}`
  }, lvl.label)))), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-2 sm:grid-cols-4 gap-2.5"
  }, ISLAND_PRESETS.map(preset => {
    const active = islandColorId === preset.id;
    return /*#__PURE__*/React.createElement("button", {
      key: preset.id,
      onClick: () => setIslandColorId(preset.id),
      className: `p-3 rounded-2xl border text-left transition-all space-y-2 ${active ? 'border-[#007AFF] ring-2 ring-[#007AFF]/25 bg-blue-500/5' : darkMode ? 'border-white/10 hover:bg-white/5' : 'border-zinc-200/80 hover:bg-zinc-50'}`
    }, /*#__PURE__*/React.createElement("div", {
      className: `h-6 px-2.5 rounded-full border flex items-center justify-between gap-1.5 shadow-sm ${preset.isLight ? 'text-zinc-900 border-zinc-300' : 'text-white border-white/20'}`,
      style: {
        background: getIslandThemeBackgroundCss(preset.id, islandIntensity, islandGradientMode, islandCustomBg)
      }
    }, /*#__PURE__*/React.createElement("span", {
      className: "w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_6px_#34d399]"
    }), /*#__PURE__*/React.createElement("span", {
      className: "text-[9px] font-semibold truncate"
    }, "\u7075\u52A8\u5C9B"), /*#__PURE__*/React.createElement("span", {
      className: "flex items-center gap-0.5"
    }, /*#__PURE__*/React.createElement("span", {
      className: "w-0.5 h-2 rounded-full bg-emerald-400"
    }), /*#__PURE__*/React.createElement("span", {
      className: "w-0.5 h-3 rounded-full bg-blue-400"
    }), /*#__PURE__*/React.createElement("span", {
      className: "w-0.5 h-2 rounded-full bg-purple-400"
    }))), /*#__PURE__*/React.createElement("div", {
      className: "min-w-0"
    }, /*#__PURE__*/React.createElement("div", {
      className: "text-xs font-bold truncate"
    }, preset.name), /*#__PURE__*/React.createElement("div", {
      className: "text-[10px] opacity-55 truncate"
    }, preset.desc)));
  })), islandColorId === 'custom' && /*#__PURE__*/React.createElement("div", {
    className: `p-3.5 rounded-2xl border flex flex-wrap items-center gap-6 ${darkMode ? 'bg-black/40 border-white/10' : 'bg-zinc-50 border-zinc-200'}`
  }, /*#__PURE__*/React.createElement("label", {
    className: "flex items-center gap-2.5 text-xs font-medium cursor-pointer"
  }, /*#__PURE__*/React.createElement("span", null, "\u7075\u52A8\u5C9B\u5E95\u8272\uFF1A"), /*#__PURE__*/React.createElement("input", {
    type: "color",
    value: islandCustomBg,
    onChange: e => setIslandCustomBg(e.target.value),
    className: "w-8 h-8 rounded-lg cursor-pointer border-0 bg-transparent"
  }), /*#__PURE__*/React.createElement("span", {
    className: "font-mono text-[11px] opacity-70"
  }, islandCustomBg)), /*#__PURE__*/React.createElement("label", {
    className: "flex items-center gap-2.5 text-xs font-medium cursor-pointer"
  }, /*#__PURE__*/React.createElement("span", null, "\u5FAE\u5149\u8FB9\u6846\u8272\uFF1A"), /*#__PURE__*/React.createElement("input", {
    type: "color",
    value: islandCustomBorder,
    onChange: e => setIslandCustomBorder(e.target.value),
    className: "w-8 h-8 rounded-lg cursor-pointer border-0 bg-transparent"
  }), /*#__PURE__*/React.createElement("span", {
    className: "font-mono text-[11px] opacity-70"
  }, islandCustomBorder)))), /*#__PURE__*/React.createElement("div", {
    id: "appearance-bubbles",
    className: `scroll-mt-4 p-5 rounded-3xl border space-y-6 ${darkMode ? 'bg-white/[0.03] border-white/[0.08]' : 'bg-white border-zinc-200/80 shadow-xs'}`
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h3", {
    className: "text-sm font-bold"
  }, "\uD83D\uDCAC \u804A\u5929\u6C14\u6CE1\u6B3E\u5F0F\u3001\u914D\u8272\u4E0E\u5355 AI \u72EC\u7ACB\u5B9A\u5236"), /*#__PURE__*/React.createElement("p", {
    className: "text-[11px] opacity-55 mt-0.5"
  }, "\u6240\u6709\u989C\u8272\u548C\u5F62\u72B6\u9009\u9879\u5747\u76F4\u63A5\u4EE5\u300C\u5FAE\u7F29\u804A\u5929\u6C14\u6CE1\u300D\u6837\u5F0F\u5C55\u793A\uFF1B\u65E2\u53EF\u8BBE\u7F6E\u5168\u5C40\u9ED8\u8BA4\u6C14\u6CE1\uFF0C\u4E5F\u53EF\u4E3A\u4EFB\u610F AI \u5355\u72EC\u6307\u5B9A\u4E13\u5C5E\u6C14\u6CE1\u5F62\u72B6\u548C\u989C\u8272\u3002")), /*#__PURE__*/React.createElement("div", {
    className: "space-y-2.5"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-xs font-semibold opacity-80"
  }, "1. \u5168\u5C40\u6C14\u6CE1\u51E0\u4F55\u9020\u578B\u6B3E\u5F0F\uFF08\u76F4\u63A5\u7528\u5C0F\u6C14\u6CE1\u5C55\u793A\u5C3E\u89D2\u4E0E\u66F2\u7387\uFF09"), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-2 sm:grid-cols-4 gap-2.5"
  }, BUBBLE_STYLES.map(st => {
    const active = bubbleStyleId === st.id;
    return /*#__PURE__*/React.createElement("button", {
      key: st.id,
      onClick: () => setBubbleStyleId(st.id),
      className: `p-3 rounded-2xl border text-left transition-all space-y-2 ${active ? 'border-[#007AFF] ring-2 ring-[#007AFF]/25 bg-blue-500/5' : darkMode ? 'border-white/10 hover:bg-white/5' : 'border-zinc-200/80 hover:bg-zinc-50'}`
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex items-center justify-between gap-1.5 py-1 px-1.5 rounded-xl bg-black/[0.03] dark:bg-white/[0.03]"
    }, /*#__PURE__*/React.createElement("span", {
      className: `px-2.5 py-1 inline-flex items-center text-[9px] font-semibold shadow-2xs ${darkMode ? 'bg-zinc-800 text-zinc-100 border border-white/10' : 'bg-white text-zinc-800 border border-zinc-200/90'} ${st.botRadius} ${st.id === 'glass' ? 'backdrop-blur-xl ring-1 ring-white/40 shadow-sm' : ''}`
    }, "AI \u6C14\u6CE1"), /*#__PURE__*/React.createElement("span", {
      className: `px-2.5 py-1 inline-flex items-center text-[9px] font-semibold bg-gradient-to-br from-[#007AFF] to-[#0055D4] text-white shadow-2xs ${st.meRadius} ${st.id === 'glass' ? 'backdrop-blur-xl ring-1 ring-white/40 shadow-sm' : ''}`
    }, "\u6211\u65B9 \u2728")), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      className: "text-xs font-bold truncate"
    }, st.name), /*#__PURE__*/React.createElement("div", {
      className: "text-[10px] opacity-55 mt-0.5 line-clamp-1"
    }, st.desc)));
  }))), /*#__PURE__*/React.createElement("div", {
    className: "space-y-2.5"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-xs font-semibold opacity-80"
  }, "2. \u300C\u6211\u300D\u7684\u53D1\u9001\u6C14\u6CE1\u989C\u8272\uFF08\u5C0F\u6C14\u6CE1\u6837\u5F0F\u76F4\u63A5\u9884\u89C8\uFF09"), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-2 sm:grid-cols-4 gap-2.5"
  }, MY_BUBBLE_COLORS.map(c => {
    const active = myBubbleColorId === c.id;
    return /*#__PURE__*/React.createElement("button", {
      key: c.id,
      onClick: () => setMyBubbleColorId(c.id),
      className: `p-3 rounded-2xl border text-left transition-all space-y-2 ${active ? 'border-[#007AFF] ring-2 ring-[#007AFF]/25 bg-blue-500/5' : darkMode ? 'border-white/10 hover:bg-white/5' : 'border-zinc-200/80 hover:bg-zinc-50'}`
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex justify-end"
    }, /*#__PURE__*/React.createElement("span", {
      className: `px-3 py-1 inline-flex items-center justify-center text-[10px] font-semibold border border-black/10 ${currentBubbleStyle.meRadius} ${c.className}`,
      style: c.id === 'custom' ? {
        backgroundColor: myBubbleCustomBg,
        color: myBubbleCustomText
      } : undefined
    }, "\u53D1\u6D88\u606F \u2728")), /*#__PURE__*/React.createElement("div", {
      className: "text-xs font-bold truncate"
    }, c.name));
  })), myBubbleColorId === 'custom' && /*#__PURE__*/React.createElement("div", {
    className: `p-3.5 rounded-2xl border flex flex-wrap items-center gap-6 mt-2 ${darkMode ? 'bg-black/40 border-white/10' : 'bg-zinc-50 border-zinc-200'}`
  }, /*#__PURE__*/React.createElement("label", {
    className: "flex items-center gap-2 text-xs font-medium cursor-pointer"
  }, /*#__PURE__*/React.createElement("span", null, "\u6211\u7684\u6C14\u6CE1\u80CC\u666F\u8272\uFF1A"), /*#__PURE__*/React.createElement("input", {
    type: "color",
    value: myBubbleCustomBg,
    onChange: e => setMyBubbleCustomBg(e.target.value),
    className: "w-8 h-8 rounded-lg cursor-pointer border-0 bg-transparent"
  }), /*#__PURE__*/React.createElement("span", {
    className: "font-mono text-[11px] opacity-70"
  }, myBubbleCustomBg)), /*#__PURE__*/React.createElement("label", {
    className: "flex items-center gap-2 text-xs font-medium cursor-pointer"
  }, /*#__PURE__*/React.createElement("span", null, "\u6211\u7684\u6C14\u6CE1\u6587\u5B57\u8272\uFF1A"), /*#__PURE__*/React.createElement("input", {
    type: "color",
    value: myBubbleCustomText,
    onChange: e => setMyBubbleCustomText(e.target.value),
    className: "w-8 h-8 rounded-lg cursor-pointer border-0 bg-transparent"
  }), /*#__PURE__*/React.createElement("span", {
    className: "font-mono text-[11px] opacity-70"
  }, myBubbleCustomText)))), /*#__PURE__*/React.createElement("div", {
    className: "space-y-2.5"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-xs font-semibold opacity-80"
  }, "3. \u5168\u5C40 AI \u7FA4\u53CB\u63A5\u6536\u6C14\u6CE1\u9ED8\u8BA4\u914D\u8272\u6A21\u5F0F"), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-2 sm:grid-cols-4 gap-2.5"
  }, [{
    id: 'adaptive',
    name: '主题自适应',
    desc: '浅色白底 / 深色暗灰'
  }, {
    id: 'role-tinted',
    name: 'AI 角色专属染色',
    desc: '随各模型主题色微光染色'
  }, {
    id: 'frosted-glass',
    name: '高透磨砂玻璃',
    desc: '半透明背景模糊质感'
  }, {
    id: 'custom',
    name: '全局自定义色',
    desc: '统一指定 AI 默认气泡色'
  }].map(m => {
    const active = botBubbleMode === m.id;
    const sampleClass = m.id === 'role-tinted' ? darkMode ? 'bg-emerald-950/70 text-emerald-100 border border-emerald-500/30' : 'bg-emerald-50 text-emerald-950 border border-emerald-200' : m.id === 'frosted-glass' ? darkMode ? 'bg-white/10 text-zinc-100 border border-white/20 backdrop-blur' : 'bg-white/70 text-zinc-800 border border-white/90 backdrop-blur' : m.id === 'custom' ? 'border border-black/10 shadow-xs' : darkMode ? 'bg-zinc-800 text-zinc-100 border border-white/10' : 'bg-white text-zinc-800 border border-zinc-200';
    return /*#__PURE__*/React.createElement("button", {
      key: m.id,
      onClick: () => setBotBubbleMode(m.id),
      className: `p-3 rounded-2xl border text-left transition-all space-y-2 ${active ? 'border-[#007AFF] ring-2 ring-[#007AFF]/25 bg-blue-500/5' : darkMode ? 'border-white/10 hover:bg-white/5' : 'border-zinc-200/80 hover:bg-zinc-50'}`
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex justify-start"
    }, /*#__PURE__*/React.createElement("span", {
      style: m.id === 'custom' ? {
        backgroundColor: botBubbleCustomBg,
        color: botBubbleCustomText
      } : undefined,
      className: `inline-flex px-2.5 py-1 items-center justify-center text-[10px] font-semibold ${currentBubbleStyle.botRadius} ${sampleClass}`
    }, "AI \u56DE\u590D\u793A\u4F8B")), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      className: "text-xs font-bold"
    }, m.name), /*#__PURE__*/React.createElement("div", {
      className: "text-[10px] opacity-55 mt-0.5"
    }, m.desc)));
  })), botBubbleMode === 'custom' && /*#__PURE__*/React.createElement("div", {
    className: `p-3.5 rounded-2xl border space-y-3 mt-2 ${darkMode ? 'bg-black/40 border-white/10' : 'bg-zinc-50 border-zinc-200'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-[11px] font-semibold opacity-75"
  }, "\u5FEB\u901F\u9009\u62E9\u5168\u5C40 AI \u6C14\u6CE1\u9884\u8BBE\u5C0F\u6C14\u6CE1\u8272\u5361\uFF1A"), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-2 sm:grid-cols-4 gap-2"
  }, BOT_BUBBLE_PRESETS.map(preset => {
    const isSelected = botBubbleCustomBg.toLowerCase() === preset.bg.toLowerCase() && botBubbleCustomText.toLowerCase() === preset.text.toLowerCase();
    return /*#__PURE__*/React.createElement("button", {
      key: preset.id,
      type: "button",
      onClick: () => {
        setBotBubbleCustomBg(preset.bg);
        setBotBubbleCustomText(preset.text);
      },
      className: `p-2 rounded-xl border text-left flex items-center gap-2 transition-all ${isSelected ? 'border-[#007AFF] ring-2 ring-[#007AFF]/20 bg-blue-500/5' : darkMode ? 'border-white/10 hover:bg-white/5' : 'border-zinc-200 hover:bg-white'}`
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        backgroundColor: preset.bg,
        color: preset.text
      },
      className: `px-2 py-0.5 text-[9px] font-semibold border border-black/10 shrink-0 ${currentBubbleStyle.botRadius}`
    }, "AI"), /*#__PURE__*/React.createElement("span", {
      className: "text-[11px] font-medium truncate"
    }, preset.name));
  })), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap items-center gap-6 pt-1"
  }, /*#__PURE__*/React.createElement("label", {
    className: "flex items-center gap-2 text-xs font-medium cursor-pointer"
  }, /*#__PURE__*/React.createElement("span", null, "AI \u6C14\u6CE1\u80CC\u666F\u8272\uFF1A"), /*#__PURE__*/React.createElement("input", {
    type: "color",
    value: botBubbleCustomBg,
    onChange: e => setBotBubbleCustomBg(e.target.value),
    className: "w-8 h-8 rounded-lg cursor-pointer border-0 bg-transparent"
  }), /*#__PURE__*/React.createElement("span", {
    className: "font-mono text-[11px] opacity-70"
  }, botBubbleCustomBg)), /*#__PURE__*/React.createElement("label", {
    className: "flex items-center gap-2 text-xs font-medium cursor-pointer"
  }, /*#__PURE__*/React.createElement("span", null, "AI \u6C14\u6CE1\u6587\u5B57\u8272\uFF1A"), /*#__PURE__*/React.createElement("input", {
    type: "color",
    value: botBubbleCustomText,
    onChange: e => setBotBubbleCustomText(e.target.value),
    className: "w-8 h-8 rounded-lg cursor-pointer border-0 bg-transparent"
  }), /*#__PURE__*/React.createElement("span", {
    className: "font-mono text-[11px] opacity-70"
  }, botBubbleCustomText))))), /*#__PURE__*/React.createElement("div", {
    className: `p-4 rounded-2xl border space-y-4 ${darkMode ? 'bg-black/30 border-white/10' : 'bg-zinc-50/90 border-zinc-200/80'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap items-center justify-between gap-2"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "text-xs font-bold flex items-center gap-1.5"
  }, /*#__PURE__*/React.createElement("span", null, "4. \u5355\u4E2A AI \u7FA4\u53CB\u6C14\u6CE1\u72EC\u7ACB\u5B9A\u5236\uFF08\u6BCF\u4E2A AI \u53EF\u5355\u72EC\u8BBE\u5F62\u72B6\u4E0E\u989C\u8272\uFF09")), /*#__PURE__*/React.createElement("p", {
    className: "text-[10px] opacity-60 mt-0.5"
  }, "\u70B9\u9009\u4E0B\u65B9\u4EFB\u610F AI \u5373\u53EF\u5355\u72EC\u5B9A\u5236\u5B83\u7684\u6C14\u6CE1\u5F62\u72B6\u4E0E\u914D\u8272\uFF1B\u9876\u90E8\u9884\u89C8\u53F0\u4F1A\u4E0E\u56FA\u5B9A\u7F6E\u9876\u7684 GPT \u793A\u4F8B\u540C\u5C4F\u5B9E\u65F6\u5BF9\u6BD4\u3002"))), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2 overflow-x-auto pb-1 no-scrollbar"
  }, bots.map(b => {
    const isSelected = (selectedAvatarTarget !== 'me' ? selectedAvatarTarget : selectedBubbleBotId) === b.id;
    const hasCustom = Boolean(b.bubbleStyleId) || Boolean(b.bubbleCustomEnabled);
    return /*#__PURE__*/React.createElement("button", {
      key: b.id,
      type: "button",
      onClick: () => {
        setSelectedBubbleBotId(b.id);
        setSelectedAvatarTarget(b.id);
      },
      className: `px-3 py-2 rounded-2xl border flex items-center gap-2 shrink-0 transition-all ${isSelected ? 'border-[#007AFF] ring-2 ring-[#007AFF]/25 bg-blue-500/10' : darkMode ? 'border-white/10 hover:bg-white/5' : 'border-zinc-200 bg-white hover:bg-zinc-50'}`
    }, renderEntityAvatar(b, 'w-6 h-6', 'text-[9px]'), /*#__PURE__*/React.createElement("div", {
      className: "text-left"
    }, /*#__PURE__*/React.createElement("div", {
      className: "text-xs font-bold flex items-center gap-1"
    }, /*#__PURE__*/React.createElement("span", null, b.name), hasCustom && /*#__PURE__*/React.createElement("span", {
      className: "text-[9px] px-1.5 py-0.2 rounded-full bg-blue-500 text-white font-semibold"
    }, "\u5DF2\u5B9A\u5236")), /*#__PURE__*/React.createElement("div", {
      className: "text-[10px] opacity-55"
    }, hasCustom ? '独立专属气泡' : '跟随全局设置')));
  })), (() => {
    const targetBotId = selectedAvatarTarget !== 'me' ? selectedAvatarTarget : selectedBubbleBotId;
    const targetBot = bots.find(b => b.id === targetBotId) || bots[0];
    if (!targetBot) return null;
    const activeBotShape = BUBBLE_STYLES.find(style => style.id === targetBot.bubbleStyleId) || currentBubbleStyle;
    const updateTargetBot = patch => {
      setBots(bs => bs.map(b => b.id === targetBot.id ? {
        ...b,
        ...patch
      } : b));
    };
    return /*#__PURE__*/React.createElement("div", {
      className: "space-y-4 pt-1"
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-black/5 dark:border-white/10"
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex items-center gap-2.5"
    }, renderEntityAvatar(targetBot, 'w-7 h-7', 'text-[10px]'), /*#__PURE__*/React.createElement("span", {
      className: "text-xs font-bold"
    }, "\u6B63\u5728\u5B9A\u5236\uFF1A", targetBot.name), /*#__PURE__*/React.createElement("span", {
      style: getBotBubbleInlineStyle(targetBot),
      className: `text-[11px] ${activeBotShape.extraClass} ${activeBotShape.botRadius} ${getBotBubbleClasses(targetBot)}`
    }, targetBot.name, " \u7684\u4E13\u5C5E\u5C0F\u6C14\u6CE1\u5B9E\u65F6\u9884\u89C8")), (targetBot.bubbleStyleId || targetBot.bubbleCustomEnabled) && /*#__PURE__*/React.createElement("button", {
      type: "button",
      onClick: () => updateTargetBot({
        bubbleStyleId: undefined,
        bubbleCustomEnabled: false,
        bubbleBg: undefined,
        bubbleText: undefined
      }),
      className: "text-[11px] text-blue-500 hover:underline font-medium"
    }, "\u91CD\u7F6E\u4E3A\u8DDF\u968F\u5168\u5C40\u6C14\u6CE1")), /*#__PURE__*/React.createElement("div", {
      className: "space-y-2"
    }, /*#__PURE__*/React.createElement("div", {
      className: "text-[11px] font-semibold opacity-75"
    }, "\u2460 \u9009\u62E9 ", targetBot.name, " \u7684\u6C14\u6CE1\u5F62\u72B6\uFF08\u70B9\u51FB\u5C0F\u6C14\u6CE1\u5207\u6362\uFF09\uFF1A"), /*#__PURE__*/React.createElement("div", {
      className: "grid grid-cols-2 sm:grid-cols-4 gap-2"
    }, /*#__PURE__*/React.createElement("button", {
      type: "button",
      onClick: () => updateTargetBot({
        bubbleStyleId: undefined
      }),
      className: `p-2.5 rounded-2xl border text-left transition-all flex items-center gap-2 ${!targetBot.bubbleStyleId ? 'border-[#007AFF] ring-2 ring-[#007AFF]/20 bg-blue-500/5' : darkMode ? 'border-white/10 hover:bg-white/5' : 'border-zinc-200 bg-white hover:bg-zinc-50'}`
    }, /*#__PURE__*/React.createElement("span", {
      style: getBotBubbleInlineStyle(targetBot),
      className: `px-2 py-0.5 text-[9px] font-semibold shrink-0 ${currentBubbleStyle.botRadius} ${getBotBubbleClasses(targetBot)}`
    }, "\u5168\u5C40"), /*#__PURE__*/React.createElement("div", {
      className: "min-w-0"
    }, /*#__PURE__*/React.createElement("div", {
      className: "text-[11px] font-bold truncate"
    }, "\u8DDF\u968F\u5168\u5C40\u5F62\u72B6"), /*#__PURE__*/React.createElement("div", {
      className: "text-[9px] opacity-55 truncate"
    }, currentBubbleStyle.name))), BUBBLE_STYLES.map(style => {
      const isSelected = targetBot.bubbleStyleId === style.id;
      return /*#__PURE__*/React.createElement("button", {
        key: style.id,
        type: "button",
        onClick: () => updateTargetBot({
          bubbleStyleId: style.id
        }),
        className: `p-2.5 rounded-2xl border text-left transition-all flex items-center gap-2 ${isSelected ? 'border-[#007AFF] ring-2 ring-[#007AFF]/20 bg-blue-500/5' : darkMode ? 'border-white/10 hover:bg-white/5' : 'border-zinc-200 bg-white hover:bg-zinc-50'}`
      }, /*#__PURE__*/React.createElement("span", {
        style: getBotBubbleInlineStyle(targetBot),
        className: `px-2 py-0.5 text-[9px] font-semibold shrink-0 ${style.botRadius} ${getBotBubbleClasses(targetBot)}`
      }, "AI"), /*#__PURE__*/React.createElement("div", {
        className: "min-w-0"
      }, /*#__PURE__*/React.createElement("div", {
        className: "text-[11px] font-bold truncate"
      }, style.name), /*#__PURE__*/React.createElement("div", {
        className: "text-[9px] opacity-55 truncate"
      }, "\u72EC\u7ACB\u5F62\u72B6")));
    }))), /*#__PURE__*/React.createElement("div", {
      className: "space-y-2"
    }, /*#__PURE__*/React.createElement("div", {
      className: "text-[11px] font-semibold opacity-75"
    }, "\u2461 \u9009\u62E9 ", targetBot.name, " \u7684\u6C14\u6CE1\u989C\u8272\uFF08\u70B9\u51FB\u5C0F\u6C14\u6CE1\u5207\u6362\uFF09\uFF1A"), /*#__PURE__*/React.createElement("div", {
      className: "grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2"
    }, /*#__PURE__*/React.createElement("button", {
      type: "button",
      onClick: () => updateTargetBot({
        bubbleCustomEnabled: false
      }),
      className: `p-2.5 rounded-2xl border text-left transition-all flex items-center gap-2 ${!targetBot.bubbleCustomEnabled ? 'border-[#007AFF] ring-2 ring-[#007AFF]/20 bg-blue-500/5' : darkMode ? 'border-white/10 hover:bg-white/5' : 'border-zinc-200 bg-white hover:bg-zinc-50'}`
    }, /*#__PURE__*/React.createElement("span", {
      className: `px-2 py-0.5 text-[9px] font-semibold shrink-0 ${activeBotShape.botRadius} ${darkMode ? 'bg-zinc-800 text-zinc-100 border border-white/10' : 'bg-white text-zinc-800 border border-zinc-200'}`
    }, "\u9ED8\u8BA4"), /*#__PURE__*/React.createElement("span", {
      className: "text-[11px] font-bold truncate"
    }, "\u8DDF\u968F\u5168\u5C40\u914D\u8272")), BOT_BUBBLE_PRESETS.map(preset => {
      const isSelected = targetBot.bubbleCustomEnabled && (targetBot.bubbleBg || '').toLowerCase() === preset.bg.toLowerCase() && (targetBot.bubbleText || '').toLowerCase() === preset.text.toLowerCase();
      return /*#__PURE__*/React.createElement("button", {
        key: preset.id,
        type: "button",
        onClick: () => updateTargetBot({
          bubbleCustomEnabled: true,
          bubbleBg: preset.bg,
          bubbleText: preset.text
        }),
        className: `p-2.5 rounded-2xl border text-left transition-all flex items-center gap-2 ${isSelected ? 'border-[#007AFF] ring-2 ring-[#007AFF]/20 bg-blue-500/5' : darkMode ? 'border-white/10 hover:bg-white/5' : 'border-zinc-200 bg-white hover:bg-zinc-50'}`
      }, /*#__PURE__*/React.createElement("span", {
        style: {
          backgroundColor: preset.bg,
          color: preset.text
        },
        className: `px-2 py-0.5 text-[9px] font-semibold border border-black/10 shrink-0 ${activeBotShape.botRadius}`
      }, "Aa"), /*#__PURE__*/React.createElement("span", {
        className: "text-[11px] font-medium truncate"
      }, preset.name));
    })), /*#__PURE__*/React.createElement("div", {
      className: "flex flex-wrap items-center gap-5 pt-1"
    }, /*#__PURE__*/React.createElement("label", {
      className: "flex items-center gap-2 text-xs font-medium cursor-pointer"
    }, /*#__PURE__*/React.createElement("span", null, targetBot.name, " \u4E13\u5C5E\u5E95\u8272\uFF1A"), /*#__PURE__*/React.createElement("input", {
      type: "color",
      value: targetBot.bubbleBg || botBubbleCustomBg,
      onChange: event => updateTargetBot({
        bubbleCustomEnabled: true,
        bubbleBg: event.target.value,
        bubbleText: targetBot.bubbleText || botBubbleCustomText
      }),
      className: "w-7 h-7 rounded-lg cursor-pointer border-0 bg-transparent"
    }), /*#__PURE__*/React.createElement("span", {
      className: "font-mono text-[11px] opacity-70"
    }, targetBot.bubbleBg || botBubbleCustomBg)), /*#__PURE__*/React.createElement("label", {
      className: "flex items-center gap-2 text-xs font-medium cursor-pointer"
    }, /*#__PURE__*/React.createElement("span", null, targetBot.name, " \u4E13\u5C5E\u6587\u5B57\u8272\uFF1A"), /*#__PURE__*/React.createElement("input", {
      type: "color",
      value: targetBot.bubbleText || botBubbleCustomText,
      onChange: event => updateTargetBot({
        bubbleCustomEnabled: true,
        bubbleBg: targetBot.bubbleBg || botBubbleCustomBg,
        bubbleText: event.target.value
      }),
      className: "w-7 h-7 rounded-lg cursor-pointer border-0 bg-transparent"
    }), /*#__PURE__*/React.createElement("span", {
      className: "font-mono text-[11px] opacity-70"
    }, targetBot.bubbleText || botBubbleCustomText)))));
  })())), /*#__PURE__*/React.createElement("div", {
    id: "appearance-theme",
    className: `scroll-mt-4 p-5 rounded-3xl border space-y-4 ${darkMode ? 'bg-white/[0.03] border-white/[0.08]' : 'bg-white border-zinc-200/80 shadow-xs'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap items-center justify-between gap-2"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h3", {
    className: "text-sm font-bold flex items-center gap-2"
  }, /*#__PURE__*/React.createElement("span", null, "\uD83C\uDFA8 \u5168\u5C40\u754C\u9762\u4E3B\u9898\u8272\u76D8\uFF08\u5171 ", THEME_PRESETS.length, " \u6B3E\u51B7\u6696/\u83AB\u5170\u8FEA/\u6697\u591C\u642D\u914D\uFF09\u4E0E\u7A97\u53E3\u8FB9\u6846\u6A21\u5F0F")), /*#__PURE__*/React.createElement("p", {
    className: "text-[11px] opacity-55 mt-0.5"
  }, "\u6DB5\u76D6\u5411\u65E5\u8475\u9EC4\u3001\u7126\u7CD6\u62FF\u94C1\u3001\u8D64\u9676\u6A58\u3001\u4E39\u7802\u7EA2\u3001\u96FE\u973E\u84DD\u3001\u85B0\u8863\u8349\u96EA\u3001\u5929\u9752\u5B8B\u74F7\u3001\u5B87\u6CBB\u62B9\u8336\u3001\u5E72\u67AF\u73AB\u7470\u3001\u6CE2\u5C14\u591A\u9152\u7EA2\u3001\u514B\u83B1\u56E0\u84DD\u7B49\u4E30\u5BCC\u8272\u5F69\u3002")), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-1 bg-black/5 dark:bg-white/5 p-1 rounded-xl border border-black/5 dark:border-white/10"
  }, [{
    id: 'unified',
    label: '一体式真圆角窗口'
  }, {
    id: 'floating',
    label: '分栏内嵌卡片'
  }].map(wm => /*#__PURE__*/React.createElement("button", {
    key: wm.id,
    onClick: () => setWindowLayoutMode(wm.id),
    className: `px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all ${windowLayoutMode === wm.id ? 'bg-[#007AFF] text-white shadow-2xs' : 'opacity-65 hover:opacity-100'}`
  }, wm.label)))), /*#__PURE__*/React.createElement("div", {
    className: `flex flex-wrap items-center justify-between gap-2 p-3 rounded-2xl border ${isLightDopamineTheme ? 'bg-black/[0.04] border-black/10 text-zinc-900' : darkMode ? 'bg-white/[0.03] border-white/10 text-zinc-200' : 'bg-zinc-50 border-zinc-200 text-zinc-900'}`
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "text-xs font-bold flex items-center gap-1.5"
  }, /*#__PURE__*/React.createElement("span", null, "\uD83C\uDF08 \u4E3B\u9898\u5448\u73B0\u6A21\u5F0F"), /*#__PURE__*/React.createElement("span", {
    className: "text-[10px] px-2 py-0.5 rounded-full bg-orange-500/15 text-orange-500 font-semibold"
  }, themeColorMode === 'basic' ? '基础款 (纯净多巴胺底色)' : '渐变款 (灵动岛同款流光渐变)')), /*#__PURE__*/React.createElement("div", {
    className: "text-[10px] opacity-65 mt-0.5"
  }, "\u5DF2\u7CBE\u7B80\u53BB\u91CD\u76F8\u4F3C\u8272\uFF0C\u65B0\u589E\u9C9C\u6A59\u8272\u3001\u6697\u7D2B\u3001\u4EAE\u7D2B\u3001\u9752\u84DD\u3001\u78A7\u7EFF\u3001\u706B\u7EA2\u3001\u6697\u7EA2\u3001\u6E5B\u84DD 8 \u6B3E\u591A\u5DF4\u80FA\u914D\u8272\uFF0C\u652F\u6301\u57FA\u7840\u6B3E\u4E0E\u6E10\u53D8\u6B3E\u4E00\u952E\u5207\u6362\u3002")), /*#__PURE__*/React.createElement("div", {
    className: `flex p-1 rounded-xl border ${darkMode ? 'bg-black/40 border-white/10' : 'bg-white border-zinc-200'} text-xs font-bold shrink-0`
  }, [{
    id: 'basic',
    label: '🎨 基础款'
  }, {
    id: 'gradient',
    label: '✨ 渐变款'
  }].map(tm => /*#__PURE__*/React.createElement("button", {
    key: tm.id,
    type: "button",
    onClick: () => setThemeColorMode(tm.id),
    className: `px-3.5 py-1.5 rounded-lg transition-all ${themeColorMode === tm.id ? 'bg-[#007AFF] text-white shadow-sm' : 'opacity-70 hover:opacity-100'}`
  }, tm.label)))), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap items-center gap-1.5 pt-0.5"
  }, [{
    id: 'all',
    label: `✨ 全部精简主题 (${THEME_PRESETS.length})`
  }, {
    id: 'dopamine',
    label: '🔥 多巴胺配色 (鲜橙/暗紫/亮紫/青蓝/碧绿/火红/暗红/湛蓝)'
  }, {
    id: 'classic',
    label: '🍎 经典代表色 (冰川白/曜石黑/钛金灰/莫兰迪青)'
  }].map(cat => {
    const active = themeCategoryFilter === cat.id;
    return /*#__PURE__*/React.createElement("button", {
      key: cat.id,
      type: "button",
      onClick: () => setThemeCategoryFilter(cat.id),
      className: `px-3 py-1.5 rounded-xl text-[11px] font-medium border transition-all ${active ? 'bg-[#007AFF] border-[#007AFF] text-white font-semibold shadow-xs' : darkMode ? 'bg-white/[0.04] border-white/10 text-zinc-300 hover:bg-white/10' : 'bg-zinc-100/80 border-zinc-200/80 text-zinc-700 hover:bg-zinc-200/70'}`
    }, cat.label);
  })), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3"
  }, THEME_PRESETS.filter(t => themeCategoryFilter === 'all' || t.category === themeCategoryFilter).map(t => {
    const active = themeId === t.id;
    const catBadge = t.category === 'dopamine' ? '🔥 多巴胺' : '🍎 经典';
    return /*#__PURE__*/React.createElement("button", {
      key: t.id,
      onClick: () => handleSelectTheme(t.id),
      className: `p-3.5 rounded-2xl border text-left transition-all space-y-2 ${active ? 'border-[#007AFF] ring-2 ring-[#007AFF]/25 bg-blue-500/5' : darkMode ? 'border-white/10 hover:bg-white/5' : 'border-zinc-200/80 hover:bg-zinc-50'}`
    }, /*#__PURE__*/React.createElement("div", {
      className: "p-2 rounded-xl border border-black/10 flex items-center justify-between gap-1",
      style: {
        background: themeColorMode === 'gradient' ? t.gradientBg || t.previewColors[0] : t.basicBg || t.previewColors[0]
      }
    }, /*#__PURE__*/React.createElement("span", {
      className: `px-2 py-0.5 text-[8px] font-semibold shadow-2xs ${currentBubbleStyle.botRadius}`,
      style: {
        backgroundColor: t.previewColors[1],
        color: t.dark ? '#F4F4F5' : '#18181B'
      }
    }, "AI"), /*#__PURE__*/React.createElement("span", {
      className: `px-2 py-0.5 text-[8px] font-semibold text-white shadow-2xs ${currentBubbleStyle.meRadius}`,
      style: {
        backgroundColor: t.previewColors[2]
      }
    }, "\u6211")), /*#__PURE__*/React.createElement("div", {
      className: "flex items-center justify-between gap-1"
    }, /*#__PURE__*/React.createElement("div", {
      className: "text-xs font-bold truncate"
    }, t.name), /*#__PURE__*/React.createElement("span", {
      className: "text-[9px] px-1.5 py-0.5 rounded bg-black/5 dark:bg-white/10 opacity-75 shrink-0"
    }, catBadge)), /*#__PURE__*/React.createElement("div", {
      className: "text-[10px] opacity-55 line-clamp-1"
    }, t.desc));
  }))), /*#__PURE__*/React.createElement("div", {
    id: "appearance-badges",
    className: `scroll-mt-4 p-5 rounded-3xl border space-y-5 ${darkMode ? 'bg-white/[0.03] border-white/[0.08]' : 'bg-white border-zinc-200/80 shadow-xs'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap items-center justify-between gap-2"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h3", {
    className: "text-sm font-bold flex items-center gap-2"
  }, /*#__PURE__*/React.createElement("span", null, "\uD83D\uDD34 \u672A\u8BFB\u89D2\u6807\u3001\u6025\u505C\u5706\u70B9\u4E0E\u7F6E\u9876\u5361\u7247\u89C6\u89C9\u6837\u5F0F")), /*#__PURE__*/React.createElement("p", {
    className: "text-[11px] opacity-55 mt-0.5"
  }, "\u96C6\u4E2D\u5B9A\u5236\u5DE6\u4FA7\u7FA4\u5217\u8868\u7684\u672A\u8BFB\u89D2\u6807\uFF08\u5F62\u72B6\u3001\u5C3A\u5BF8\u3001\u989C\u8272\uFF09\u3001\u9876\u680F\u6025\u505C\u547C\u5438\u5706\u70B9\u914D\u8272\uFF0C\u4EE5\u53CA\u7FA4\u7F6E\u9876\u7126\u70B9\u5361\u7247\u7684\u5C55\u793A\u5F62\u5F0F\u3002")), /*#__PURE__*/React.createElement("div", {
    className: `px-3 py-1.5 rounded-2xl border flex items-center gap-3 text-xs ${darkMode ? 'bg-black/30 border-white/10' : 'bg-zinc-50 border-zinc-200'}`
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-[11px] opacity-65"
  }, "\u89D2\u6807\u4E0E\u5706\u70B9\u9884\u89C8\uFF1A"), (() => {
    const shape = featureSettings.unreadBadgeShape || 'pill';
    const size = featureSettings.unreadBadgeSize || 'md';
    const badgeColor = featureSettings.unreadBadgeColor || '#FF3B30';
    if (shape === 'dot') {
      const dotSize = size === 'sm' ? 'w-2 h-2' : size === 'lg' ? 'w-3 h-3' : 'w-2.5 h-2.5';
      return /*#__PURE__*/React.createElement("span", {
        style: {
          backgroundColor: badgeColor
        },
        className: `${dotSize} rounded-full inline-block shadow-xs`
      });
    }
    const shapeCls = shape === 'capsule' ? 'rounded-md' : 'rounded-full';
    const sizeCls = size === 'sm' ? 'min-w-3.5 h-3.5 px-1 text-[8px]' : size === 'lg' ? 'min-w-5 h-5 px-2 text-[10px]' : 'min-w-4 h-4 px-1.5 text-[9px]';
    return /*#__PURE__*/React.createElement("span", {
      style: {
        backgroundColor: badgeColor
      },
      className: `${shapeCls} ${sizeCls} text-white font-bold inline-flex items-center justify-center shadow-xs`
    }, "3");
  })(), /*#__PURE__*/React.createElement("span", {
    className: "opacity-30"
  }, "|"), /*#__PURE__*/React.createElement("span", {
    className: "inline-flex items-center gap-1 text-[11px]"
  }, /*#__PURE__*/React.createElement("span", {
    className: "w-3 h-3 rounded-full inline-block shadow-xs",
    style: {
      backgroundColor: emergencyDotColor
    }
  }), /*#__PURE__*/React.createElement("span", {
    className: "opacity-70"
  }, "\u6025\u505C\u539F\u70B9")))), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-1 md:grid-cols-3 gap-4"
  }, /*#__PURE__*/React.createElement("div", {
    className: `p-4 rounded-2xl border space-y-3 ${darkMode ? 'bg-black/25 border-white/10' : 'bg-zinc-50/80 border-zinc-200/80'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-xs font-bold"
  }, "1. \u7FA4\u672A\u8BFB\u89D2\u6807\u5F62\u72B6\u4E0E\u5C3A\u5BF8"), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "text-[11px] opacity-60 mb-1.5"
  }, "\u89D2\u6807\u51E0\u4F55\u5F62\u72B6\uFF1A"), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap gap-1.5"
  }, [{
    id: 'pill',
    label: '正圆药丸'
  }, {
    id: 'capsule',
    label: '方角胶囊'
  }, {
    id: 'dot',
    label: '极简圆点'
  }].map(s => /*#__PURE__*/React.createElement("button", {
    key: s.id,
    type: "button",
    onClick: () => setFeatureSettings(prev => ({
      ...prev,
      unreadBadgeShape: s.id
    })),
    className: `px-2.5 py-1.5 rounded-xl border text-[11px] font-medium transition-all ${(featureSettings.unreadBadgeShape || 'pill') === s.id ? 'bg-[#007AFF] border-[#007AFF] text-white font-semibold shadow-2xs' : darkMode ? 'bg-black/30 border-white/10 hover:bg-white/5' : 'bg-white border-zinc-200 hover:bg-zinc-100'}`
  }, s.label)))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "text-[11px] opacity-60 mb-1.5"
  }, "\u89D2\u6807\u5C3A\u5BF8\u5927\u5C0F\uFF1A"), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap gap-1.5"
  }, [{
    id: 'sm',
    label: '紧凑小 (SM)'
  }, {
    id: 'md',
    label: '标准适中 (MD)'
  }, {
    id: 'lg',
    label: '醒目大 (LG)'
  }].map(sz => /*#__PURE__*/React.createElement("button", {
    key: sz.id,
    type: "button",
    onClick: () => setFeatureSettings(prev => ({
      ...prev,
      unreadBadgeSize: sz.id
    })),
    className: `px-2.5 py-1.5 rounded-xl border text-[11px] font-medium transition-all ${(featureSettings.unreadBadgeSize || 'md') === sz.id ? 'bg-[#007AFF] border-[#007AFF] text-white font-semibold shadow-2xs' : darkMode ? 'bg-black/30 border-white/10 hover:bg-white/5' : 'bg-white border-zinc-200 hover:bg-zinc-100'}`
  }, sz.label))))), /*#__PURE__*/React.createElement("div", {
    className: `p-4 rounded-2xl border space-y-3 ${darkMode ? 'bg-black/25 border-white/10' : 'bg-zinc-50/80 border-zinc-200/80'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-xs font-bold"
  }, "2. \u672A\u8BFB\u89D2\u6807\u8272 & \u9876\u680F\u6025\u505C\u5706\u70B9\u8272"), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "text-[11px] opacity-60 mb-1.5"
  }, "\u672A\u8BFB\u6D88\u606F\u89D2\u6807\u989C\u8272\uFF1A"), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap items-center gap-1.5"
  }, [{
    name: '经典红',
    value: '#FF3B30'
  }, {
    name: '电光蓝',
    value: '#007AFF'
  }, {
    name: '翡翠绿',
    value: '#10B981'
  }, {
    name: '琥珀橙',
    value: '#F59E0B'
  }, {
    name: '魅影紫',
    value: '#8B5CF6'
  }].map(c => /*#__PURE__*/React.createElement("button", {
    key: c.value,
    type: "button",
    onClick: () => setFeatureSettings(prev => ({
      ...prev,
      unreadBadgeColor: c.value
    })),
    className: `px-2 py-1 rounded-full border text-[10px] inline-flex items-center gap-1.5 ${(featureSettings.unreadBadgeColor || '#FF3B30') === c.value ? 'border-[#007AFF] ring-2 ring-[#007AFF]/20 font-semibold' : darkMode ? 'border-white/10 bg-white/5' : 'border-zinc-200 bg-white'}`
  }, /*#__PURE__*/React.createElement("span", {
    className: "w-2.5 h-2.5 rounded-full",
    style: {
      backgroundColor: c.value
    }
  }), c.name)), /*#__PURE__*/React.createElement("label", {
    className: "px-2 py-1 rounded-full border text-[10px] inline-flex items-center gap-1 cursor-pointer"
  }, /*#__PURE__*/React.createElement("input", {
    type: "color",
    value: featureSettings.unreadBadgeColor || '#FF3B30',
    onChange: e => setFeatureSettings(prev => ({
      ...prev,
      unreadBadgeColor: e.target.value
    })),
    className: "w-3.5 h-3.5 rounded-full border-0 bg-transparent cursor-pointer"
  }), "\u81EA\u5B9A\u4E49"))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "text-[11px] opacity-60 mb-1.5"
  }, "\u9876\u680F\u4E00\u952E\u6025\u505C\u5706\u70B9\u989C\u8272\uFF1A"), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap items-center gap-1.5"
  }, EMERGENCY_DOT_COLORS.map(color => /*#__PURE__*/React.createElement("button", {
    key: color.value,
    type: "button",
    onClick: () => setEmergencyDotColor(color.value),
    className: `px-2 py-1 rounded-full border text-[10px] inline-flex items-center gap-1.5 ${emergencyDotColor === color.value ? 'border-[#007AFF] ring-2 ring-[#007AFF]/20 font-semibold' : darkMode ? 'border-white/10 bg-white/5' : 'border-zinc-200 bg-white'}`
  }, /*#__PURE__*/React.createElement("span", {
    className: "w-2.5 h-2.5 rounded-full",
    style: {
      backgroundColor: color.value
    }
  }), color.name)), /*#__PURE__*/React.createElement("label", {
    className: "px-2 py-1 rounded-full border text-[10px] inline-flex items-center gap-1 cursor-pointer"
  }, /*#__PURE__*/React.createElement("input", {
    type: "color",
    value: emergencyDotColor,
    onChange: event => setEmergencyDotColor(event.target.value),
    className: "w-3.5 h-3.5 rounded-full border-0 bg-transparent cursor-pointer"
  }), "\u81EA\u5B9A\u4E49")))), /*#__PURE__*/React.createElement("div", {
    className: `p-4 rounded-2xl border space-y-3 ${darkMode ? 'bg-black/25 border-white/10' : 'bg-zinc-50/80 border-zinc-200/80'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-xs font-bold"
  }, "3. \u672C\u7FA4\u7F6E\u9876\u7126\u70B9\u5361\u7247\u663E\u793A\u6A21\u5F0F"), /*#__PURE__*/React.createElement("p", {
    className: "text-[10px] opacity-60 leading-relaxed"
  }, "\u63A7\u5236\u53F3\u4FA7\u8FB9\u680F\u9876\u90E8\u300C\uD83D\uDCCC \u672C\u7FA4\u7F6E\u9876\u7126\u70B9\u300D\u5361\u7247\u7684\u5C55\u793A\u65B9\u5F0F\uFF1B\u5982\u679C\u4E4B\u524D\u70B9\u4E86\u9690\u85CF\uFF0C\u53EF\u5728\u6B64\u5904\u968F\u65F6\u6062\u590D\u663E\u793A\u3002"), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-1 gap-1.5"
  }, [{
    id: 'both',
    label: '📌 标准展开显示 (推荐)',
    desc: '在右栏醒目展示置顶内容与定位按钮'
  }, {
    id: 'hidden',
    label: '🙈 隐藏右侧置顶卡片',
    desc: '仅保留置顶消息突破长文限制的后台特权'
  }].map(pm => /*#__PURE__*/React.createElement("button", {
    key: pm.id,
    type: "button",
    onClick: () => {
      setPinDisplayMode(pm.id);
      if (pm.id !== 'hidden') setPinCardCollapsed(false);
    },
    className: `p-2.5 rounded-xl border text-left transition-all ${pinDisplayMode === pm.id ? 'border-[#007AFF] bg-blue-500/10 text-blue-600 dark:text-blue-400 font-semibold' : darkMode ? 'border-white/10 bg-black/20 hover:bg-white/5' : 'border-zinc-200 bg-white hover:bg-zinc-50'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-[11px]"
  }, pm.label), /*#__PURE__*/React.createElement("div", {
    className: "text-[9px] opacity-60 mt-0.5"
  }, pm.desc))))))), /*#__PURE__*/React.createElement("div", {
    id: "appearance-avatars",
    className: `scroll-mt-4 p-5 rounded-3xl border space-y-5 ${darkMode ? 'bg-white/[0.03] border-white/[0.08]' : 'bg-white border-zinc-200/80 shadow-xs'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap items-center justify-between gap-2"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h3", {
    className: "text-sm font-bold"
  }, "\uD83D\uDC64 \u5934\u50CF\u3001\u8EAB\u4EFD\u4E0E AI \u4EBA\u8BBE\u5DE5\u574A\uFF08\u652F\u6301\u56FE\u7247 / Emoji / \u6E10\u53D8\u5FBD\u7AE0 / \u968F\u65F6\u6539\u4EBA\u8BBE\uFF09"), /*#__PURE__*/React.createElement("p", {
    className: "text-[11px] opacity-55 mt-0.5"
  }, "\u70B9\u51FB\u4E0B\u65B9\u89D2\u8272\u5207\u6362\u7F16\u8F91\u5BF9\u8C61\uFF0C\u53EF\u4E3A\u300C\u6211\u300D\u548C\u6BCF\u4F4D AI \u5355\u72EC\u6362\u5934\u50CF\u3001\u6539\u6635\u79F0\u3001\u6539\u8EAB\u4EFD\u6807\u7B7E\u4E0E\u4E13\u5C5E\u4EBA\u8BBE\u63D0\u793A\u8BCD\u3002")), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-1 bg-black/5 dark:bg-white/5 p-1 rounded-xl border border-black/5 dark:border-white/10"
  }, [{
    id: 'rounded-2xl',
    label: 'Apple 圆角'
  }, {
    id: 'rounded-full',
    label: '经典正圆'
  }, {
    id: 'rounded-lg',
    label: '极客方角'
  }].map(sh => /*#__PURE__*/React.createElement("button", {
    key: sh.id,
    onClick: () => setAvatarShape(sh.id),
    className: `px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all ${avatarShape === sh.id ? 'bg-[#007AFF] text-white shadow-2xs' : 'opacity-65 hover:opacity-100'}`
  }, sh.label)))), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2 overflow-x-auto pb-1 no-scrollbar"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setSelectedAvatarTarget('me'),
    className: `px-3.5 py-2 rounded-2xl border flex items-center gap-2.5 shrink-0 transition-all ${selectedAvatarTarget === 'me' ? 'border-[#007AFF] ring-2 ring-[#007AFF]/25 bg-blue-500/10' : darkMode ? 'border-white/10 hover:bg-white/5' : 'border-zinc-200 hover:bg-zinc-50'}`
  }, renderEntityAvatar('me', 'w-7 h-7', 'text-[10px]'), /*#__PURE__*/React.createElement("div", {
    className: "text-left"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-xs font-bold"
  }, myProfile.name), /*#__PURE__*/React.createElement("div", {
    className: "text-[10px] opacity-55"
  }, "\u4E3B\u7406\u4EBA (\u6211)"))), bots.map(b => /*#__PURE__*/React.createElement("button", {
    key: b.id,
    onClick: () => {
      setSelectedAvatarTarget(b.id);
      setSelectedBubbleBotId(b.id);
    },
    className: `px-3.5 py-2 rounded-2xl border flex items-center gap-2.5 shrink-0 transition-all ${selectedAvatarTarget === b.id ? 'border-[#007AFF] ring-2 ring-[#007AFF]/25 bg-blue-500/10' : darkMode ? 'border-white/10 hover:bg-white/5' : 'border-zinc-200 hover:bg-zinc-50'}`
  }, renderEntityAvatar(b, 'w-7 h-7', 'text-[10px]'), /*#__PURE__*/React.createElement("div", {
    className: "text-left"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-xs font-bold"
  }, b.name), /*#__PURE__*/React.createElement("div", {
    className: "text-[10px] opacity-55"
  }, b.roleTag))))), (() => {
    const isEditingMe = selectedAvatarTarget === 'me';
    const targetData = isEditingMe ? myProfile : bots.find(b => b.id === selectedAvatarTarget) || bots[0];
    const updateTarget = patch => {
      if (isEditingMe) {
        setMyProfile(prev => ({
          ...prev,
          ...patch
        }));
      } else {
        setBots(bs => bs.map(b => b.id === targetData.id ? {
          ...b,
          ...patch
        } : b));
      }
    };
    return /*#__PURE__*/React.createElement("div", {
      className: `p-4 rounded-2xl border space-y-4 ${darkMode ? 'bg-black/30 border-white/10' : 'bg-zinc-50/80 border-zinc-200/80'}`
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex flex-wrap items-center gap-4"
    }, renderEntityAvatar(isEditingMe ? 'me' : targetData, 'w-16 h-16', 'text-xl'), /*#__PURE__*/React.createElement("div", {
      className: "space-y-2 flex-1 min-w-[200px]"
    }, /*#__PURE__*/React.createElement("div", {
      className: `grid grid-cols-1 ${isEditingMe ? 'sm:grid-cols-2' : 'sm:grid-cols-3'} gap-2.5`
    }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
      className: "block text-[10px] opacity-60 mb-1"
    }, "\u7FA4\u804A\u663E\u793A\u6635\u79F0"), /*#__PURE__*/React.createElement("input", {
      type: "text",
      value: targetData.name,
      onChange: e => updateTarget({
        name: e.target.value
      }),
      className: `w-full text-xs font-semibold px-3 py-1.5 rounded-xl border ${darkMode ? 'bg-black/40 border-white/15 text-white' : 'bg-white border-zinc-200 text-zinc-900'}`
    })), !isEditingMe && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
      className: "block text-[10px] opacity-60 mb-1"
    }, "\u8EAB\u4EFD\u6807\u7B7E (Role Tag)"), /*#__PURE__*/React.createElement("input", {
      type: "text",
      value: targetData.roleTag || '',
      onChange: e => updateTarget({
        roleTag: e.target.value
      }),
      placeholder: "\u4F8B\u5982\uFF1A\u6BD2\u820C\u9996\u5E2D\u67B6\u6784\u5E08",
      className: `w-full text-xs font-semibold px-3 py-1.5 rounded-xl border ${darkMode ? 'bg-black/40 border-white/15 text-white' : 'bg-white border-zinc-200 text-zinc-900'}`
    })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
      className: "block text-[10px] opacity-60 mb-1"
    }, "\u6587\u5B57\u5FBD\u7AE0\u7F29\u5199 (1~3\u5B57)"), /*#__PURE__*/React.createElement("input", {
      type: "text",
      maxLength: 3,
      value: targetData.badge || '',
      onChange: e => updateTarget({
        avatarType: 'badge',
        badge: e.target.value
      }),
      className: `w-full text-xs font-mono px-3 py-1.5 rounded-xl border ${darkMode ? 'bg-black/40 border-white/15 text-white' : 'bg-white border-zinc-200 text-zinc-900'}`
    }))))), !isEditingMe && /*#__PURE__*/React.createElement("div", {
      className: `p-3.5 rounded-2xl border space-y-2 ${darkMode ? 'border-white/10 bg-white/[0.03]' : 'border-zinc-200 bg-white'}`
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex items-center justify-between"
    }, /*#__PURE__*/React.createElement("span", {
      className: "text-xs font-semibold flex items-center gap-1.5"
    }, /*#__PURE__*/React.createElement(Sparkles, {
      className: "w-3.5 h-3.5 text-amber-500"
    }), /*#__PURE__*/React.createElement("span", null, targetData.name, " \u7684\u4E13\u5C5E\u4EBA\u8BBE\u63D0\u793A\u8BCD\uFF08\u968F\u65F6\u4FEE\u6539\u5373\u65F6\u751F\u6548\uFF09")), /*#__PURE__*/React.createElement("span", {
      className: "text-[10px] text-emerald-500 font-medium"
    }, "\u4E0B\u6B21\u540C\u6B65\u81EA\u52A8\u63D0\u9192\u8BE5\u7F51\u9875 AI")), /*#__PURE__*/React.createElement("textarea", {
      rows: 2,
      value: targetData.persona || '',
      onChange: e => updateTarget({
        persona: e.target.value
      }),
      placeholder: "\u5199\u4E0B\u8FD9\u4F4D AI \u5728\u7FA4\u91CC\u7684\u6027\u683C\u3001\u4E13\u4E1A\u89C6\u89D2\u3001\u8BF4\u8BDD\u957F\u77ED\u548C\u4E92\u603C\u98CE\u683C...",
      className: `w-full text-xs p-2.5 rounded-xl border leading-relaxed ${darkMode ? 'bg-black/40 border-white/10 text-zinc-200' : 'bg-zinc-50 border-zinc-200 text-zinc-800'}`
    })), /*#__PURE__*/React.createElement("div", {
      className: "grid grid-cols-1 md:grid-cols-2 gap-4 pt-1"
    }, /*#__PURE__*/React.createElement("div", {
      className: "space-y-3"
    }, /*#__PURE__*/React.createElement("div", {
      className: "text-xs font-semibold opacity-75"
    }, "\u9009\u62E9\u6F6E\u6D41 Emoji \u5934\u50CF\u6216\u4E0A\u4F20\u672C\u5730\u56FE\u7247"), /*#__PURE__*/React.createElement("div", {
      className: "flex flex-wrap gap-1.5"
    }, EMOJI_PRESETS.map(em => /*#__PURE__*/React.createElement("button", {
      key: em,
      onClick: () => updateTarget({
        avatarType: 'emoji',
        emoji: em
      }),
      className: `w-8 h-8 rounded-xl text-base flex items-center justify-center border transition-all hover:scale-110 ${targetData.avatarType === 'emoji' && targetData.emoji === em ? 'border-[#007AFF] bg-blue-500/15 ring-2 ring-[#007AFF]/20' : darkMode ? 'border-white/10 bg-white/5' : 'border-zinc-200 bg-white'}`
    }, em))), /*#__PURE__*/React.createElement("div", {
      className: "flex flex-wrap items-center gap-2 pt-1"
    }, /*#__PURE__*/React.createElement("label", {
      className: "px-3 py-1.5 rounded-xl bg-[#007AFF] hover:bg-blue-600 text-white text-xs font-medium cursor-pointer inline-flex items-center gap-1.5 shadow-2xs"
    }, /*#__PURE__*/React.createElement(Upload, {
      className: "w-3.5 h-3.5"
    }), /*#__PURE__*/React.createElement("span", null, "\u4E0A\u4F20\u672C\u5730\u5934\u50CF\u56FE\u7247"), /*#__PURE__*/React.createElement("input", {
      type: "file",
      accept: ".jpg,.jpeg,.png,.gif,.webp,.svg",
      onChange: e => handleAvatarFileUpload(e, isEditingMe ? 'me' : targetData.id),
      className: "hidden"
    })), /*#__PURE__*/React.createElement("input", {
      type: "text",
      placeholder: "\u6216\u7C98\u8D34\u56FE\u7247 URL (https://...)",
      value: targetData.imageUrl || '',
      onChange: e => updateTarget({
        avatarType: e.target.value ? 'image' : 'badge',
        imageUrl: e.target.value
      }),
      className: `flex-1 min-w-[160px] text-xs px-3 py-1.5 rounded-xl border ${darkMode ? 'bg-black/40 border-white/15 text-zinc-200' : 'bg-white border-zinc-200 text-zinc-800'}`
    }))), /*#__PURE__*/React.createElement("div", {
      className: "space-y-3"
    }, /*#__PURE__*/React.createElement("div", {
      className: "text-xs font-semibold opacity-75"
    }, "\u5934\u50CF\u80CC\u666F\u6E10\u53D8\u8272\u4E0E\u81EA\u7531\u62FE\u8272"), /*#__PURE__*/React.createElement("div", {
      className: "grid grid-cols-4 gap-2"
    }, AVATAR_GRADIENTS.map(g => /*#__PURE__*/React.createElement("button", {
      key: g.id,
      onClick: () => updateTarget({
        avatarBg: g.id,
        customColor: ''
      }),
      className: `p-1.5 rounded-xl border flex flex-col items-center gap-1 transition-all ${targetData.avatarBg === g.id && !targetData.customColor ? 'border-[#007AFF] ring-2 ring-[#007AFF]/25' : darkMode ? 'border-white/10 hover:bg-white/5' : 'border-zinc-200 hover:bg-white'}`
    }, /*#__PURE__*/React.createElement("span", {
      className: "w-full h-5 rounded-lg",
      style: {
        background: g.preview
      }
    }), /*#__PURE__*/React.createElement("span", {
      className: "text-[10px] truncate max-w-full"
    }, g.name)))), /*#__PURE__*/React.createElement("div", {
      className: "flex items-center gap-3 pt-1"
    }, /*#__PURE__*/React.createElement("label", {
      className: "flex items-center gap-2 text-xs font-medium cursor-pointer"
    }, /*#__PURE__*/React.createElement("span", null, "\u81EA\u5B9A\u4E49\u7EAF\u8272\u5934\u50CF\u80CC\u666F\uFF1A"), /*#__PURE__*/React.createElement("input", {
      type: "color",
      value: targetData.customColor || '#3b82f6',
      onChange: e => updateTarget({
        customColor: e.target.value
      }),
      className: "w-7 h-7 rounded-lg cursor-pointer border-0 bg-transparent"
    })), targetData.customColor && /*#__PURE__*/React.createElement("button", {
      onClick: () => updateTarget({
        customColor: ''
      }),
      className: "text-[11px] text-blue-500 hover:underline"
    }, "\u6062\u590D\u6E10\u53D8\u8272")))));
  })())))), !isMinimizedToIsland && /*#__PURE__*/React.createElement("nav", {
    "aria-label": "\u5B89\u5353\u5E95\u90E8\u5BFC\u822A\u680F",
    className: `shrink-0 z-40 px-2 py-1.5 border-t backdrop-blur-2xl flex items-center justify-around ${darkMode ? 'bg-zinc-950/75 border-white/15 text-zinc-400' : 'bg-white/75 border-white/80 text-zinc-600'}`
  }, [{
    id: 'groups',
    label: '群与游标',
    icon: Layers,
    onClick: () => setActiveTab('groups')
  }, {
    id: 'chat',
    label: '群聊',
    icon: MessageSquare,
    onClick: () => setActiveTab('chat')
  }, {
    id: 'webview',
    label: '内嵌网页',
    icon: Globe,
    onClick: () => setActiveTab('webview')
  }, {
    id: 'sync',
    label: '绑定/人设',
    icon: Link2,
    onClick: () => setActiveTab(activeTab === 'sync' ? 'anti-preach' : 'sync')
  }, {
    id: 'settings',
    label: '外观工坊',
    icon: Palette,
    onClick: () => setActiveTab('settings')
  }].map(nav => {
    const Icon = nav.icon;
    const isActive = nav.id === 'sync' ? activeTab === 'sync' || activeTab === 'anti-preach' : activeTab === nav.id;
    return /*#__PURE__*/React.createElement("button", {
      key: nav.id,
      type: "button",
      onClick: nav.onClick,
      className: `relative flex flex-col items-center justify-center py-1 px-3 rounded-2xl transition-all ${isActive ? 'text-[#007AFF] font-bold scale-105' : 'opacity-70 hover:opacity-100'}`
    }, /*#__PURE__*/React.createElement(Icon, {
      className: "w-4 h-4"
    }), /*#__PURE__*/React.createElement("span", {
      className: "text-[10px] mt-0.5 leading-none"
    }, nav.label));
  }))), showRightDrawer && !isMinimizedToIsland && /*#__PURE__*/React.createElement("div", {
    onClick: () => setShowRightDrawer(false),
    className: `${mobileViewportMode === 'desktop' ? 'hidden' : 'fixed inset-0 z-40 bg-black/35 backdrop-blur-[2px] xl:hidden'}`
  }), showRightDrawer && !isMinimizedToIsland && /*#__PURE__*/React.createElement("aside", {
    className: `w-76 max-w-[86vw] flex flex-col shrink-0 backdrop-blur-2xl transition-all duration-300 ${mobileViewportMode === 'phone-frame' ? 'absolute inset-y-0 right-0 z-50 h-full shadow-2xl' : 'fixed xl:static inset-y-0 right-0 z-50 xl:z-auto h-full shadow-2xl xl:shadow-none'} ${windowLayoutMode === 'floating' ? `rounded-3xl border shadow-sm ${currentTheme.sidebarBg}` : `rounded-none border-l ${darkMode ? 'bg-zinc-900/55 border-white/[0.08]' : 'bg-white/60 border-zinc-200/80'}`}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "h-14 px-4 border-b border-inherit flex items-center justify-between gap-2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-1.5 min-w-0"
  }, /*#__PURE__*/React.createElement(Cpu, {
    className: "w-4 h-4 text-blue-500 shrink-0"
  }), /*#__PURE__*/React.createElement("span", {
    className: "text-xs font-bold tracking-tight truncate"
  }, "\u589E\u91CF\u4E0A\u4E0B\u6587\u540C\u6B65\u4E2D\u5FC3")), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-1.5 shrink-0"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      if (msgSelectMode === 'pin') {
        setMsgSelectMode(null);
        setSelectedMsgIds([]);
      } else {
        setMsgSelectMode('pin');
        setSelectedMsgIds([]);
        showToast('已进入「置顶选择模式」：请在左侧勾选要置顶的消息');
      }
    },
    title: "\u7F6E\u9876\u6D88\u606F (\u591A\u9009\u540E\u9489\u9009\u81F3\u672C\u7FA4\u7126\u70B9\uFF0C\u5E76\u8D4B\u4E88\u7A81\u7834\u957F\u6D88\u606F\u9650\u5236\u7279\u6743)",
    className: `w-7 h-7 rounded-full flex items-center justify-center transition-all shadow-xs ${msgSelectMode === 'pin' ? 'bg-amber-500 text-white shadow-amber-500/30 scale-110' : darkMode ? 'bg-white/10 hover:bg-white/20 text-amber-300' : 'bg-black/5 hover:bg-amber-50 text-amber-700'}`
  }, /*#__PURE__*/React.createElement(Pin, {
    className: "w-3.5 h-3.5"
  })), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      if (msgSelectMode === 'forward') {
        setMsgSelectMode(null);
        setSelectedMsgIds([]);
      } else {
        setMsgSelectMode('forward');
        setSelectedMsgIds([]);
        showToast('已进入「转发选择模式」：请在左侧勾选要转发的消息');
      }
    },
    title: "\u8F6C\u53D1\u6D88\u606F (\u591A\u9009\u540E\u53EF\u8F6C\u7ED9\u5176\u4ED6\u7FA4\u804A\u6216\u4E00\u952E\u7FA4\u53D1)",
    className: `w-7 h-7 rounded-full flex items-center justify-center transition-all shadow-xs ${msgSelectMode === 'forward' ? 'bg-[#007AFF] text-white shadow-blue-500/30 scale-110' : darkMode ? 'bg-white/10 hover:bg-white/20 text-blue-300' : 'bg-black/5 hover:bg-blue-50 text-blue-700'}`
  }, /*#__PURE__*/React.createElement(CornerUpRight, {
    className: "w-3.5 h-3.5"
  })), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      if (msgSelectMode === 'delete') {
        setMsgSelectMode(null);
        setSelectedMsgIds([]);
      } else {
        setMsgSelectMode('delete');
        setSelectedMsgIds([]);
        showToast('已进入「删除选择模式」：请在左侧勾选要永久删除的消息');
      }
    },
    title: "\u5220\u9664\u6D88\u606F (\u591A\u9009\u540E\u6C38\u4E45\u5220\u9664)",
    className: `w-7 h-7 rounded-full flex items-center justify-center transition-all shadow-xs ${msgSelectMode === 'delete' ? 'bg-rose-500 text-white shadow-rose-500/30 scale-110' : darkMode ? 'bg-white/10 hover:bg-white/20 text-rose-300' : 'bg-black/5 hover:bg-rose-50 text-rose-700'}`
  }, /*#__PURE__*/React.createElement(Trash2, {
    className: "w-3.5 h-3.5"
  })))), /*#__PURE__*/React.createElement("div", {
    className: "flex-1 overflow-y-auto p-4 space-y-3.5"
  }, (() => {
    const pinnedIds = activeGroupState.pinnedMessageIds || [];
    const pinnedList = messages.filter(m => pinnedIds.includes(m.id));
    if (!pinnedList.length || pinDisplayMode === 'hidden') return null;
    return /*#__PURE__*/React.createElement("div", {
      className: `p-3.5 rounded-2xl border transition-all ${darkMode ? 'bg-amber-950/20 border-amber-500/30 text-amber-200' : 'bg-amber-50/80 border-amber-200/90 text-amber-900'}`
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex items-center justify-between gap-2 mb-2"
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex items-center gap-1.5 font-bold text-xs"
    }, /*#__PURE__*/React.createElement(Pin, {
      className: "w-3.5 h-3.5 text-amber-500 fill-amber-500"
    }), /*#__PURE__*/React.createElement("span", null, "\u672C\u7FA4\u7F6E\u9876\u7126\u70B9 (", pinnedList.length, ")")), /*#__PURE__*/React.createElement("div", {
      className: "flex items-center gap-2 text-[10px]"
    }, /*#__PURE__*/React.createElement("button", {
      onClick: () => setPinCardCollapsed(prev => !prev),
      className: "text-amber-600 dark:text-amber-400 hover:underline font-medium"
    }, pinCardCollapsed ? '展开' : '折叠'), /*#__PURE__*/React.createElement("button", {
      onClick: () => {
        setPinDisplayMode('hidden');
        showToast('已隐藏置顶卡片（可在设置中随时恢复显示）');
      },
      className: "opacity-50 hover:opacity-100 text-zinc-500 hover:underline",
      title: "\u5F7B\u5E95\u9690\u85CF\u6B64\u5361\u7247"
    }, "\u9690\u85CF"))), !pinCardCollapsed && /*#__PURE__*/React.createElement("div", {
      className: "space-y-2 mt-2"
    }, pinnedList.map(pinMsg => {
      const isExpanded = expandedPinIds.includes(pinMsg.id);
      const text = pinMsg.text || '（图片/媒体）';
      const isMultiLine = text.length > 50 || text.includes('\n');
      return /*#__PURE__*/React.createElement("div", {
        key: pinMsg.id,
        className: `p-2.5 rounded-xl border text-[11px] leading-relaxed transition-all ${darkMode ? 'bg-black/30 border-white/10' : 'bg-white border-amber-200/60 shadow-xs'}`
      }, /*#__PURE__*/React.createElement("div", {
        className: "flex items-center justify-between gap-2 mb-1"
      }, /*#__PURE__*/React.createElement("span", {
        className: "font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-1"
      }, /*#__PURE__*/React.createElement("span", null, pinMsg.senderName), /*#__PURE__*/React.createElement("span", {
        className: "text-[9px] opacity-50 font-normal"
      }, "\xB7 ", pinMsg.time)), /*#__PURE__*/React.createElement("div", {
        className: "flex items-center gap-1.5"
      }, /*#__PURE__*/React.createElement("button", {
        onClick: () => scrollToMessage(pinMsg.id),
        title: "\u5728\u804A\u5929\u6D41\u4E2D\u5B9A\u4F4D\u9AD8\u4EAE",
        className: "text-[10px] text-blue-500 hover:underline"
      }, "\u5B9A\u4F4D"), /*#__PURE__*/React.createElement("button", {
        onClick: () => {
          updateGroupState(activeGroupId, state => ({
            ...state,
            pinnedMessageIds: (state.pinnedMessageIds || []).filter(id => id !== pinMsg.id)
          }));
          showToast('已取消置顶该消息');
        },
        title: "\u53D6\u6D88\u7F6E\u9876",
        className: "opacity-50 hover:opacity-100 text-rose-500"
      }, /*#__PURE__*/React.createElement(X, {
        className: "w-3 h-3"
      })))), /*#__PURE__*/React.createElement("div", {
        className: `${isExpanded ? '' : 'line-clamp-2'} text-zinc-700 dark:text-zinc-300`
      }, text), isMultiLine && /*#__PURE__*/React.createElement("button", {
        onClick: () => {
          setExpandedPinIds(prev => prev.includes(pinMsg.id) ? prev.filter(id => id !== pinMsg.id) : [...prev, pinMsg.id]);
        },
        className: "text-[10px] text-blue-500 hover:underline mt-1 font-medium"
      }, isExpanded ? '收起' : '展开全文'));
    })));
  })(), /*#__PURE__*/React.createElement("div", {
    className: `p-3.5 rounded-2xl border text-[11px] leading-relaxed ${darkMode ? 'bg-white/[0.03] border-white/[0.06] text-zinc-300' : 'bg-zinc-50/90 border-zinc-200/60 text-zinc-600'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "font-semibold text-zinc-900 dark:text-white mb-1 flex items-center gap-1.5"
  }, /*#__PURE__*/React.createElement(Layers, {
    className: "w-3.5 h-3.5 text-blue-500"
  }), /*#__PURE__*/React.createElement("span", null, "\u4E3A\u4EC0\u4E48\u4E0D\u7528\u91CD\u53D1\u5168\u90E8\u5386\u53F2\uFF1F")), "\u6BCF\u4F4D\u804A\u5929\u4EBA\u5728\u6BCF\u4E2A\u7FA4\u804A\u90FD\u6709\u72EC\u7ACB\u6E38\u6807\u3002\u7CFB\u7EDF\u53EA\u5C06\u6E38\u6807\u4E4B\u540E\u7684\u65B0\u6D88\u606F\u6CE8\u5165\u5BF9\u5E94\u7F51\u9875\uFF0C\u907F\u514D\u91CD\u590D\u63D0\u4EA4\u5B8C\u6574\u5386\u53F2\u3002"), /*#__PURE__*/React.createElement("div", {
    className: "space-y-2.5"
  }, activeBots.map(bot => {
    const unread = getUnreadMessagesForBot(bot.id);
    const percent = messages.length > 0 ? Math.round(getCursorForBot(bot.id) / messages.length * 100) : 100;
    return /*#__PURE__*/React.createElement("div", {
      key: bot.id,
      className: `p-3.5 rounded-2xl border transition-all space-y-2.5 ${darkMode ? 'bg-white/[0.03] border-white/[0.07]' : 'bg-white border-zinc-200/70 shadow-2xs'}`
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex items-center justify-between"
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex items-center gap-2 min-w-0"
    }, renderEntityAvatar(bot, 'w-6 h-6', 'text-[9px]'), /*#__PURE__*/React.createElement("div", {
      className: "min-w-0"
    }, /*#__PURE__*/React.createElement("div", {
      className: "text-xs font-semibold leading-none truncate"
    }, bot.name), /*#__PURE__*/React.createElement("div", {
      className: "text-[10px] opacity-45 mt-0.5 truncate"
    }, bot.roleTag))), /*#__PURE__*/React.createElement("div", {
      className: "flex items-center gap-1.5 shrink-0"
    }, /*#__PURE__*/React.createElement("button", {
      onClick: () => setPersonaEditorBotId(bot.id),
      title: `编辑 ${bot.name} 的人设`,
      className: "p-1 rounded-lg opacity-55 hover:opacity-100 hover:bg-black/5 dark:hover:bg-white/10 transition-opacity"
    }, /*#__PURE__*/React.createElement(Pencil, {
      className: "w-3 h-3"
    })), /*#__PURE__*/React.createElement("span", {
      className: "text-[10px] font-mono opacity-60"
    }, "#", getCursorForBot(bot.id), " / #", messages.length))), /*#__PURE__*/React.createElement("div", {
      className: `w-full h-1.5 rounded-full overflow-hidden ${darkMode ? 'bg-white/10' : 'bg-zinc-100'}`
    }, /*#__PURE__*/React.createElement("div", {
      className: `h-full bg-gradient-to-r ${bot.avatarBg} transition-all duration-500`,
      style: {
        width: `${percent}%`
      }
    })), unread.length === 0 ? /*#__PURE__*/React.createElement("div", {
      className: "flex items-center justify-between text-[10px]"
    }, /*#__PURE__*/React.createElement("span", {
      className: "text-emerald-500 font-medium flex items-center gap-1"
    }, /*#__PURE__*/React.createElement(CheckCircle2, {
      className: "w-3 h-3"
    }), " \u5386\u53F2\u5DF2\u5B8C\u5168\u5BF9\u9F50"), /*#__PURE__*/React.createElement("button", {
      onClick: () => triggerBotReply(bot.id, messages),
      className: "opacity-60 hover:opacity-100 underline"
    }, "\u50AC\u4FC3\u63A5\u8BDD")) : /*#__PURE__*/React.createElement("div", {
      className: "space-y-2 pt-0.5"
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex items-center justify-between text-[10px]"
    }, /*#__PURE__*/React.createElement("span", {
      className: "text-amber-500 font-medium"
    }, "\u5F85\u6CE8\u5165\u589E\u91CF: ", unread.map(u => `#${u.id}`).join(', ')), /*#__PURE__*/React.createElement("button", {
      onClick: () => triggerBotReply(bot.id, messages),
      className: "px-2.5 py-0.5 rounded-full bg-[#007AFF] hover:bg-blue-600 text-white font-medium transition-colors"
    }, "\u7ACB\u5373\u540C\u6B65\u5E76\u53D1\u8A00")), /*#__PURE__*/React.createElement("div", {
      className: `p-2 rounded-xl text-[10px] font-mono truncate ${darkMode ? 'bg-black/40 text-zinc-400' : 'bg-zinc-50 text-zinc-500'}`
    }, unread.map(u => `[${u.senderName.split(' ')[0]}]: ${u.text}`).join(' · '))));
  })))), personaEditorBot && /*#__PURE__*/React.createElement("div", {
    className: "fixed inset-0 z-[120] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4",
    onClick: () => setPersonaEditorBotId(null)
  }, /*#__PURE__*/React.createElement("section", {
    onClick: event => event.stopPropagation(),
    className: `w-full max-w-lg rounded-3xl border p-5 shadow-2xl ${darkMode ? 'bg-zinc-900 border-white/10 text-zinc-100' : 'bg-white border-zinc-200 text-zinc-900'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-start justify-between gap-3 mb-4"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-3"
  }, renderEntityAvatar(personaEditorBot, 'w-10 h-10', 'text-xs'), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h2", {
    className: "text-base font-bold"
  }, "\u7F16\u8F91 ", personaEditorBot.name, " \u7684\u4EBA\u8BBE"), /*#__PURE__*/React.createElement("p", {
    className: "text-[11px] opacity-55 mt-1"
  }, "\u4FEE\u6539\u4F1A\u81EA\u52A8\u4FDD\u5B58\uFF1B\u4E0B\u4E00\u6761\u7FA4\u804A\u6D88\u606F\u540C\u6B65\u65F6\u5C31\u4F1A\u6309\u65B0\u8BBE\u5B9A\u63D0\u9192\u5B83\u3002"))), /*#__PURE__*/React.createElement("button", {
    onClick: () => setPersonaEditorBotId(null),
    "aria-label": "\u5173\u95ED\u4EBA\u8BBE\u7F16\u8F91",
    className: "p-2 rounded-full opacity-60 hover:opacity-100"
  }, /*#__PURE__*/React.createElement(X, {
    className: "w-4 h-4"
  }))), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-1 sm:grid-cols-2 gap-3"
  }, /*#__PURE__*/React.createElement("label", {
    className: "text-xs font-medium"
  }, "\u7FA4\u804A\u6635\u79F0", /*#__PURE__*/React.createElement("input", {
    value: personaEditorBot.name || '',
    onChange: event => setBots(previous => previous.map(bot => bot.id === personaEditorBot.id ? {
      ...bot,
      name: event.target.value
    } : bot)),
    className: `mt-1.5 w-full px-3 py-2 rounded-xl border text-sm ${darkMode ? 'bg-black/30 border-white/10' : 'bg-zinc-50 border-zinc-200'}`
  })), /*#__PURE__*/React.createElement("label", {
    className: "text-xs font-medium"
  }, "\u8EAB\u4EFD\u6807\u7B7E", /*#__PURE__*/React.createElement("input", {
    value: personaEditorBot.roleTag || '',
    onChange: event => setBots(previous => previous.map(bot => bot.id === personaEditorBot.id ? {
      ...bot,
      roleTag: event.target.value
    } : bot)),
    placeholder: "\u4F8B\u5982\uFF1A\u4EA7\u54C1\u7ECF\u7406",
    className: `mt-1.5 w-full px-3 py-2 rounded-xl border text-sm ${darkMode ? 'bg-black/30 border-white/10' : 'bg-zinc-50 border-zinc-200'}`
  }))), /*#__PURE__*/React.createElement("label", {
    className: "block text-xs font-medium mt-3"
  }, "\u80CC\u666F\u63D0\u793A\u8BCD / \u4EBA\u8BBE", /*#__PURE__*/React.createElement("textarea", {
    rows: 5,
    value: personaEditorBot.persona || '',
    onChange: event => setBots(previous => previous.map(bot => bot.id === personaEditorBot.id ? {
      ...bot,
      persona: event.target.value
    } : bot)),
    placeholder: "\u5199\u4E0B\u8FD9\u4E2A AI \u7684\u601D\u8003\u65B9\u5F0F\u3001\u53E3\u543B\u3001\u504F\u597D\u548C\u8FB9\u754C\u3002",
    className: `mt-1.5 w-full px-3 py-2.5 rounded-xl border text-sm leading-relaxed ${darkMode ? 'bg-black/30 border-white/10' : 'bg-zinc-50 border-zinc-200'}`
  })), /*#__PURE__*/React.createElement("div", {
    className: "flex justify-end mt-4"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setPersonaEditorBotId(null);
      showToast('人设已更新，下次同步时会应用');
    },
    className: "px-4 py-2 rounded-xl bg-[#007AFF] text-white text-xs font-semibold"
  }, "\u5B8C\u6210")))), systemSettingsOpen && /*#__PURE__*/React.createElement("div", {
    className: "fixed inset-0 z-[130] bg-black/45 backdrop-blur-md flex items-center justify-center p-3 sm:p-6",
    onClick: () => setSystemSettingsOpen(false)
  }, /*#__PURE__*/React.createElement("section", {
    onClick: event => event.stopPropagation(),
    className: `w-full max-w-4xl max-h-[90vh] overflow-hidden rounded-[28px] border shadow-2xl flex flex-col ${darkMode ? 'bg-zinc-900/95 border-white/10 text-zinc-100' : 'bg-white/95 border-white text-zinc-900'}`
  }, /*#__PURE__*/React.createElement("header", {
    className: "px-5 pt-4 pb-3 border-b border-black/5 dark:border-white/10 space-y-3 shrink-0"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-between gap-3"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-3"
  }, /*#__PURE__*/React.createElement("span", {
    className: "w-10 h-10 rounded-2xl bg-blue-500/10 text-blue-500 inline-flex items-center justify-center shrink-0"
  }, /*#__PURE__*/React.createElement(Settings, {
    className: "w-5 h-5"
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h2", {
    className: "font-bold text-base"
  }, "Chat H \u6838\u5FC3\u903B\u8F91\u4E0E\u8C03\u5EA6\u8BBE\u7F6E\u4E2D\u5FC3"), /*#__PURE__*/React.createElement("p", {
    className: "text-[11px] opacity-55"
  }, "\u56DB\u5927\u529F\u80FD\u5206\u533A\u4E00\u76EE\u4E86\u7136 \xB7 \u7CBE\u7EC6\u63A7\u5236\u53D1\u8A00\u8C03\u5EA6\u3001\u4E94\u6863\u5F15\u7528\u6743\u9650\u3001\u8DE8\u7FA4\u8F6C\u53D1\u7F72\u540D\u900F\u4F20\u3001\u5B57\u6570\u4E0E\u9632\u5C01\u62A4\u680F"))), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2"
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => {
      setSystemSettingsOpen(false);
      setActiveTab('settings');
      setTimeout(() => {
        document.getElementById('appearance-badges')?.scrollIntoView({
          behavior: 'smooth',
          block: 'start'
        });
      }, 80);
    },
    className: `px-3 py-1.5 rounded-xl border text-[11px] font-medium flex items-center gap-1.5 transition-colors ${darkMode ? 'bg-white/5 hover:bg-white/10 border-white/10 text-zinc-200' : 'bg-zinc-100 hover:bg-zinc-200/80 border-zinc-200 text-zinc-700'}`,
    title: "\u672A\u8BFB\u89D2\u6807\u3001\u6025\u505C\u5706\u70B9\u989C\u8272\u4E0E\u4E3B\u9898\u5DF2\u6574\u5408\u81F3\u5916\u89C2\u81EA\u5B9A\u4E49\u8BBE\u7F6E"
  }, /*#__PURE__*/React.createElement(Palette, {
    className: "w-3.5 h-3.5 text-blue-500"
  }), /*#__PURE__*/React.createElement("span", null, "\u89D2\u6807/\u5706\u70B9/\u4E3B\u9898\u5916\u89C2")), /*#__PURE__*/React.createElement("button", {
    onClick: () => setSystemSettingsOpen(false),
    className: "w-8 h-8 rounded-full hover:bg-black/5 dark:hover:bg-white/10 inline-flex items-center justify-center"
  }, /*#__PURE__*/React.createElement(X, {
    className: "w-4 h-4"
  })))), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-1.5 overflow-x-auto no-scrollbar pt-0.5"
  }, [{
    id: 'all',
    label: '📋 全部四区总览'
  }, {
    id: 'dispatch',
    label: '🎯 一区：发言与接力调度'
  }, {
    id: 'quote-forward',
    label: '💬 二区：引用权限与跨群转发'
  }, {
    id: 'context',
    label: '🧠 三区：字数、上下文与结论卡'
  }, {
    id: 'safety',
    label: '🛡️ 四区：防封护栏与极速引擎'
  }].map(tab => {
    const active = settingsCategoryTab === tab.id;
    return /*#__PURE__*/React.createElement("button", {
      key: tab.id,
      type: "button",
      onClick: () => setSettingsCategoryTab(tab.id),
      className: `shrink-0 px-3 py-1.5 rounded-xl text-xs font-semibold border transition-all ${active ? 'bg-[#007AFF] border-[#007AFF] text-white shadow-xs' : darkMode ? 'bg-white/[0.04] border-white/10 text-zinc-300 hover:bg-white/10' : 'bg-zinc-100/90 border-zinc-200/80 text-zinc-700 hover:bg-zinc-200/70'}`
    }, tab.label);
  }))), /*#__PURE__*/React.createElement("div", {
    className: "overflow-y-auto p-5 space-y-6"
  }, (settingsCategoryTab === 'all' || settingsCategoryTab === 'dispatch') && /*#__PURE__*/React.createElement("section", {
    className: `p-4 sm:p-5 rounded-3xl border-2 space-y-4 ${darkMode ? 'bg-blue-950/[0.12] border-blue-500/25' : 'bg-blue-50/40 border-blue-200/80'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap items-center justify-between gap-2 pb-2.5 border-b border-blue-500/15"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2.5"
  }, /*#__PURE__*/React.createElement("span", {
    className: "px-2.5 py-1 rounded-xl bg-blue-500 text-white text-xs font-bold shadow-xs"
  }, "\u5206\u533A 01"), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h3", {
    className: "text-sm font-bold"
  }, "\uD83C\uDFAF \u53D1\u8A00\u4F18\u5148\u7EA7\u4E0E\u7FA4\u804A\u63A5\u529B\u8C03\u5EA6"), /*#__PURE__*/React.createElement("p", {
    className: "text-[11px] opacity-60"
  }, "\u51B3\u5B9A\u4F60\u53D1\u6D88\u606F\u540E\u54EA\u4F4D AI \u7B2C\u4E00\u4E2A\u5F00\u53E3\u3001\u540E\u53F0\u5982\u4F55\u8F6E\u6D41\u63A5\u529B\u4E92\u603C\uFF0C\u4EE5\u53CA\u7FA4\u53CB\u4E4B\u95F4\u7684\u62DF\u4EBA\u505C\u987F\u8282\u594F")))), /*#__PURE__*/React.createElement("div", {
    className: "grid sm:grid-cols-2 gap-2.5"
  }, [['mentionFirst', '被 @ 点名的 AI 绝对优先', '先把消息送给你在输入框 @ 点名的 AI；指令模式下仅被 @ 的成员会回答。'], ['expertiseFirst', '专业领域对口的 AI 优先接单', '识别代码、架构、UI视觉、产品增长等关键词，自动匹配最对口人设的 AI 首发。'], ['noConsecutiveStarter', '避免同一 AI 连续两轮抢首发', '自动记录每个群上一轮的开场 AI，下一轮优先换另一位群友先开口。'], ['crossPlatformPong', '不同平台 AI 轮流乒乓接话', '值守讨论时禁止同一个 AI 自己接自己的话，强制跨模型交替发言。'], ['guidePhases', '按「破冰→交锋→拍板」推进节奏', '根据值守剩余轮数自动切换提示词重心，从发散观点逐步收敛到落地决定。'], ['stopOnConsensus', '达成共识或复读时自动提前收尾', '检测到多位 AI 明确赞同或观点完全重复时提前结束值守，避免无意义水群。'], ['antiEchoGuard', '🔥 抑制 AI 复读机与同质化附和 (新增)', '在接力提示词中注入反附和约束，要求后发言的 AI 必须补充新角度或直接挑刺，拒绝换汤不换药。'], ['raceFirstToken', '闲聊时允许双网页同时赛跑抢答', '非专业话题下同时向两位 AI 派发，谁先吐出首字就采用谁，慢的一方自动取消。']].map(([key, title, description]) => /*#__PURE__*/React.createElement("button", {
    key: key,
    type: "button",
    "aria-pressed": Boolean(featureSettings[key]),
    onClick: () => setFeatureSettings(previous => ({
      ...previous,
      [key]: !previous[key]
    })),
    className: `flex items-start gap-3 text-left p-3 rounded-2xl border transition-all ${featureSettings[key] ? darkMode ? 'bg-blue-500/15 border-blue-400/35 shadow-2xs' : 'bg-white border-blue-300 shadow-xs' : darkMode ? 'bg-black/25 border-white/[0.07] opacity-75' : 'bg-white/60 border-zinc-200/80 opacity-80'}`
  }, /*#__PURE__*/React.createElement("span", {
    className: `mt-0.5 w-8 h-[18px] rounded-full p-0.5 shrink-0 transition-colors ${featureSettings[key] ? 'bg-[#007AFF]' : 'bg-zinc-400/50'}`
  }, /*#__PURE__*/React.createElement("span", {
    className: `block w-[14px] h-[14px] rounded-full bg-white shadow-sm transition-transform ${featureSettings[key] ? 'translate-x-[14px]' : ''}`
  })), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("span", {
    className: "block text-xs font-bold"
  }, title), /*#__PURE__*/React.createElement("span", {
    className: "block text-[10px] opacity-65 leading-relaxed mt-1"
  }, description))))), /*#__PURE__*/React.createElement("div", {
    className: `p-3.5 rounded-2xl border space-y-2.5 ${darkMode ? 'bg-black/30 border-white/10' : 'bg-white border-blue-200/60'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap items-center justify-between gap-2"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "text-xs font-bold"
  }, "\u23F1\uFE0F \u7FA4\u53CB\u63A5\u529B\u62DF\u4EBA\u601D\u8003\u505C\u987F\u95F4\u9694\uFF08\u9632\u77AC\u95F4\u5E76\u53D1\u5237\u5C4F\uFF09"), /*#__PURE__*/React.createElement("div", {
    className: "text-[10px] opacity-60"
  }, "\u4E0A\u4E00\u4F4D AI \u8BF4\u5B8C\u540E\uFF0C\u7B49\u5F85\u51E0\u79D2\u518D\u5524\u9192\u4E0B\u4E00\u4F4D AI\uFF0C\u65E2\u50CF\u771F\u4EBA\u770B\u7FA4\u804A\u6253\u5B57\uFF0C\u53C8\u80FD\u663E\u8457\u964D\u4F4E\u591A\u6807\u7B7E\u9875\u5E76\u53D1\u98CE\u63A7"))), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-3 gap-2"
  }, [{
    id: 'instant',
    label: '⚡ 0.4秒 极速连发',
    desc: '追求最快连续输出速度'
  }, {
    id: 'natural',
    label: '☕ 1.2秒 自然阅读节奏 (推荐)',
    desc: '最贴合真人群聊接话呼吸感'
  }, {
    id: 'safe',
    label: '🛡️ 2.8秒 防风控慢速节奏',
    desc: '多轮长值守时最稳妥安全'
  }].map(opt => {
    const active = (featureSettings.relayDelayMode || 'natural') === opt.id;
    return /*#__PURE__*/React.createElement("button", {
      key: opt.id,
      type: "button",
      onClick: () => setFeatureSettings(prev => ({
        ...prev,
        relayDelayMode: opt.id
      })),
      className: `p-2.5 rounded-xl border text-left transition-all ${active ? 'bg-[#007AFF] border-[#007AFF] text-white font-semibold shadow-xs' : darkMode ? 'bg-black/25 border-white/10 hover:bg-white/5' : 'bg-zinc-50 border-zinc-200 hover:bg-zinc-100'}`
    }, /*#__PURE__*/React.createElement("div", {
      className: "text-xs"
    }, opt.label), /*#__PURE__*/React.createElement("div", {
      className: `text-[10px] mt-0.5 ${active ? 'text-white/85' : 'opacity-60'}`
    }, opt.desc));
  })))), (settingsCategoryTab === 'all' || settingsCategoryTab === 'quote-forward') && /*#__PURE__*/React.createElement("section", {
    className: `p-4 sm:p-5 rounded-3xl border-2 space-y-4 ${darkMode ? 'bg-purple-950/[0.12] border-purple-500/25' : 'bg-purple-50/40 border-purple-200/80'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap items-center justify-between gap-2 pb-2.5 border-b border-purple-500/15"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2.5"
  }, /*#__PURE__*/React.createElement("span", {
    className: "px-2.5 py-1 rounded-xl bg-purple-600 text-white text-xs font-bold shadow-xs"
  }, "\u5206\u533A 02"), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h3", {
    className: "text-sm font-bold"
  }, "\uD83D\uDCAC \u5F15\u7528\u6743\u9650\u63A7\u5236\u4E0E\u8DE8\u7FA4\u8F6C\u53D1\u7F72\u540D\u900F\u4F20"), /*#__PURE__*/React.createElement("p", {
    className: "text-[11px] opacity-60"
  }, "\u81EA\u7531\u5207\u6362\u300C\u90FD\u53EF\u5F15\u7528 / \u4EC5\u6211\u53EF\u5F15\u7528 / \u4EC5AI\u53EF\u5F15\u7528 / \u90E8\u5206\u5F15\u7528 / \u5173\u95ED\u300D\uFF0C\u5E76\u786E\u4FDD\u8DE8\u7FA4\u8F6C\u53D1100%\u544A\u77E5\u63A5\u6536 AI \u6D88\u606F\u51FA\u5904")))), /*#__PURE__*/React.createElement("div", {
    className: `p-4 rounded-2xl border space-y-3.5 ${darkMode ? 'bg-black/30 border-white/10' : 'bg-white border-purple-200/70'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap items-center justify-between gap-2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-xs font-bold flex items-center gap-1.5"
  }, /*#__PURE__*/React.createElement(Quote, {
    className: "w-3.5 h-3.5 text-purple-500"
  }), /*#__PURE__*/React.createElement("span", null, "1. \u7FA4\u804A\u5F15\u7528\u6743\u9650\u8303\u56F4\uFF08\u8C01\u53EF\u4EE5\u4F7F\u7528\u5F15\u7528\u529F\u80FD\uFF1F\uFF09")), /*#__PURE__*/React.createElement("span", {
    className: "text-[10px] px-2 py-0.5 rounded-full bg-purple-500/15 text-purple-500 font-semibold"
  }, "\u652F\u63015\u6863\u7CBE\u7EC6\u6743\u9650")), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-2 sm:grid-cols-5 gap-2"
  }, [{
    id: 'both',
    label: '👥 都可引用',
    desc: '我和所有 AI 均可引用'
  }, {
    id: 'me-only',
    label: '🙋‍♂️ 仅我可引用',
    desc: '仅我手点引用，AI不挂引用'
  }, {
    id: 'ai-only',
    label: '🤖 仅 AI 可引用',
    desc: '仅AI自动引用，隐藏我方按钮'
  }, {
    id: 'partial',
    label: '🎛️ 部分引用',
    desc: '指定部分AI或特定对象引用'
  }, {
    id: 'off',
    label: '🚫 全部关闭',
    desc: '全员纯净对话不显示引用条'
  }].map(perm => {
    const currentPerm = featureSettings.quotePermission || (featureSettings.quoteReplies === false ? 'off' : 'both');
    const active = currentPerm === perm.id;
    return /*#__PURE__*/React.createElement("button", {
      key: perm.id,
      type: "button",
      onClick: () => setFeatureSettings(prev => ({
        ...prev,
        quotePermission: perm.id,
        quoteReplies: perm.id !== 'off'
      })),
      className: `p-2.5 rounded-xl border text-left transition-all ${active ? 'bg-purple-600 border-purple-600 text-white font-semibold shadow-xs' : darkMode ? 'bg-black/25 border-white/10 hover:bg-white/5' : 'bg-zinc-50 border-zinc-200 hover:bg-zinc-100'}`
    }, /*#__PURE__*/React.createElement("div", {
      className: "text-xs"
    }, perm.label), /*#__PURE__*/React.createElement("div", {
      className: `text-[9px] mt-0.5 leading-snug ${active ? 'text-white/85' : 'opacity-60'}`
    }, perm.desc));
  })), featureSettings.quotePermission === 'partial' && /*#__PURE__*/React.createElement("div", {
    className: `p-3.5 rounded-2xl border space-y-3 ${darkMode ? 'bg-purple-950/20 border-purple-400/30' : 'bg-purple-50/70 border-purple-200'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap items-center justify-between gap-2"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-xs font-bold text-purple-600 dark:text-purple-300"
  }, "\uD83C\uDF9B\uFE0F \u300C\u90E8\u5206\u5F15\u7528\u300D\u81EA\u5B9A\u4E49\u767D\u540D\u5355\u4E0E\u5F15\u7528\u5BF9\u8C61\u8FC7\u6EE4\uFF1A"), /*#__PURE__*/React.createElement("label", {
    className: "inline-flex items-center gap-1.5 text-xs font-medium cursor-pointer"
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: featureSettings.partialAllowMe !== false,
    onChange: e => setFeatureSettings(prev => ({
      ...prev,
      partialAllowMe: e.target.checked
    })),
    className: "w-3.5 h-3.5 rounded text-purple-600"
  }), /*#__PURE__*/React.createElement("span", null, "\u5141\u8BB8\u6211\uFF08\u4E3B\u7406\u4EBA\uFF09\u624B\u52A8\u70B9\u51FB\u5F15\u7528"))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "text-[11px] opacity-75 mb-1.5 font-medium"
  }, "\u52FE\u9009\u5141\u8BB8\u5728\u56DE\u590D\u65F6\u81EA\u52A8\u5E26\u5F15\u7528\u6761\u7684 AI \u7FA4\u53CB\uFF08\u672A\u52FE\u9009\u7684 AI \u4FDD\u6301\u65E0\u5F15\u7528\u7EAF\u6587\u672C\u6C14\u6CE1\uFF09\uFF1A"), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap gap-2"
  }, bots.map(b => {
    const allowedList = Array.isArray(featureSettings.partialAllowedBotIds) ? featureSettings.partialAllowedBotIds : bots.map(item => item.id);
    const isChecked = allowedList.includes(b.id);
    return /*#__PURE__*/React.createElement("button", {
      key: b.id,
      type: "button",
      onClick: () => {
        const nextList = isChecked ? allowedList.filter(id => id !== b.id) : [...allowedList, b.id];
        setFeatureSettings(prev => ({
          ...prev,
          partialAllowedBotIds: nextList
        }));
      },
      className: `px-3 py-1.5 rounded-xl border text-xs flex items-center gap-2 transition-all ${isChecked ? 'bg-purple-600 border-purple-600 text-white font-semibold shadow-2xs' : darkMode ? 'bg-black/30 border-white/10 opacity-60' : 'bg-white border-zinc-200 opacity-65'}`
    }, renderEntityAvatar(b, 'w-4 h-4', 'text-[8px]', true), /*#__PURE__*/React.createElement("span", null, b.name), /*#__PURE__*/React.createElement("span", {
      className: "text-[10px]"
    }, isChecked ? '✓ 允许引用' : '不引用'));
  }))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "text-[11px] opacity-75 mb-1.5 font-medium"
  }, "AI \u81EA\u52A8\u5F15\u7528\u65F6\u7684\u76EE\u6807\u5BF9\u8C61\u8FC7\u6EE4\uFF08\u9650\u5236 AI \u53EA\u80FD\u5F15\u7528\u54EA\u7C7B\u6D88\u606F\uFF09\uFF1A"), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-2 sm:grid-cols-4 gap-2"
  }, [{
    id: 'all',
    label: '全部消息均可引用'
  }, {
    id: 'ai-only',
    label: '仅引用其他 AI 的发言'
  }, {
    id: 'me-only',
    label: '仅引用主理人的提问'
  }, {
    id: 'pinned-only',
    label: '仅引用被置顶重点消息'
  }].map(tf => {
    const active = (featureSettings.quoteTargetFilter || 'all') === tf.id;
    return /*#__PURE__*/React.createElement("button", {
      key: tf.id,
      type: "button",
      onClick: () => setFeatureSettings(prev => ({
        ...prev,
        quoteTargetFilter: tf.id
      })),
      className: `px-2.5 py-1.5 rounded-xl border text-[11px] font-medium transition-all ${active ? 'bg-purple-600 border-purple-600 text-white font-semibold' : darkMode ? 'bg-black/30 border-white/10' : 'bg-white border-zinc-200'}`
    }, tf.label);
  })))), !['off', 'me-only'].includes(featureSettings.quotePermission || 'both') && /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-1 md:grid-cols-3 gap-3 pt-1"
  }, /*#__PURE__*/React.createElement("div", {
    className: "md:col-span-2 space-y-1.5"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-[11px] font-semibold opacity-75"
  }, "AI \u56DE\u590D\u5F15\u7528\u89E6\u53D1\u65F6\u673A\uFF1A"), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-3 gap-2"
  }, [{
    id: 'smart',
    label: '🧠 智能模式 (推荐)',
    desc: '接其他AI话或转发消息时引用'
  }, {
    id: 'always',
    label: '📌 始终挂引用',
    desc: '每条AI回复都挂上文引用条'
  }, {
    id: 'mention-or-pin',
    label: '🎯 仅点名/置顶引用',
    desc: '仅被@或回应置顶消息时引用'
  }].map(opt => {
    const active = (featureSettings.quoteMode || 'smart') === opt.id;
    return /*#__PURE__*/React.createElement("button", {
      key: opt.id,
      type: "button",
      onClick: () => setFeatureSettings(prev => ({
        ...prev,
        quoteMode: opt.id
      })),
      className: `p-2 rounded-xl border text-left transition-all ${active ? 'bg-purple-500/15 border-purple-500 text-purple-600 dark:text-purple-300 font-bold' : darkMode ? 'bg-black/20 border-white/10 hover:bg-white/5' : 'bg-zinc-50 border-zinc-200 hover:bg-zinc-100'}`
    }, /*#__PURE__*/React.createElement("div", {
      className: "text-[11px]"
    }, opt.label), /*#__PURE__*/React.createElement("div", {
      className: "text-[9px] opacity-60 mt-0.5"
    }, opt.desc));
  }))), /*#__PURE__*/React.createElement("div", {
    className: "space-y-1.5"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-[11px] font-semibold opacity-75"
  }, "\u5F15\u7528\u6761\u6587\u5B57\u9884\u89C8\u957F\u5EA6\uFF1A"), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-3 gap-1.5"
  }, [{
    value: 40,
    label: '40字紧凑'
  }, {
    value: 80,
    label: '80字标准'
  }, {
    value: 140,
    label: '140字详尽'
  }].map(len => {
    const active = Number(featureSettings.quoteMaxLength || 80) === len.value;
    return /*#__PURE__*/React.createElement("button", {
      key: len.value,
      type: "button",
      onClick: () => setFeatureSettings(prev => ({
        ...prev,
        quoteMaxLength: len.value
      })),
      className: `py-2 px-2 rounded-xl border text-[11px] font-medium text-center transition-all ${active ? 'bg-purple-600 border-purple-600 text-white font-bold' : darkMode ? 'bg-black/20 border-white/10' : 'bg-zinc-50 border-zinc-200'}`
    }, len.label);
  }))))), /*#__PURE__*/React.createElement("div", {
    className: "grid sm:grid-cols-2 gap-2.5"
  }, [['forwardWithProvenance', '📨 转发消息强制附带「源群聊 + 原发言 AI」署名透传', '转发消息到其他群时，聊天气泡顶部显示来源横幅，且向目标群 AI 注入的增量提示词中明确标注「转发自群聊 X 的原发言人 Y（含角色）」，让接收 AI 100% 知晓来龙去脉。'], ['autoDispatchOnForward', '⚡ 转发消息到达目标群后立即唤醒 AI 讨论', '开启后，一旦把消息转发到目标群聊，系统会自动唤醒该群顺位第一的 AI 对转发过来的内容发表看法；关闭则仅静默存入目标群待发队列。']].map(([key, title, description]) => /*#__PURE__*/React.createElement("button", {
    key: key,
    type: "button",
    "aria-pressed": Boolean(featureSettings[key]),
    onClick: () => setFeatureSettings(previous => ({
      ...previous,
      [key]: !previous[key]
    })),
    className: `flex items-start gap-3 text-left p-3.5 rounded-2xl border transition-all ${featureSettings[key] ? darkMode ? 'bg-purple-500/15 border-purple-400/35 shadow-2xs' : 'bg-white border-purple-300 shadow-xs' : darkMode ? 'bg-black/25 border-white/[0.07] opacity-75' : 'bg-white/60 border-zinc-200/80 opacity-80'}`
  }, /*#__PURE__*/React.createElement("span", {
    className: `mt-0.5 w-8 h-[18px] rounded-full p-0.5 shrink-0 transition-colors ${featureSettings[key] ? 'bg-purple-600' : 'bg-zinc-400/50'}`
  }, /*#__PURE__*/React.createElement("span", {
    className: `block w-[14px] h-[14px] rounded-full bg-white shadow-sm transition-transform ${featureSettings[key] ? 'translate-x-[14px]' : ''}`
  })), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("span", {
    className: "block text-xs font-bold"
  }, title), /*#__PURE__*/React.createElement("span", {
    className: "block text-[10px] opacity-65 leading-relaxed mt-1"
  }, description)))))), (settingsCategoryTab === 'all' || settingsCategoryTab === 'context') && /*#__PURE__*/React.createElement("section", {
    className: `p-4 sm:p-5 rounded-3xl border-2 space-y-4 ${darkMode ? 'bg-amber-950/[0.12] border-amber-500/25' : 'bg-amber-50/40 border-amber-200/80'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap items-center justify-between gap-2 pb-2.5 border-b border-amber-500/15"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2.5"
  }, /*#__PURE__*/React.createElement("span", {
    className: "px-2.5 py-1 rounded-xl bg-amber-500 text-white text-xs font-bold shadow-xs"
  }, "\u5206\u533A 03"), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h3", {
    className: "text-sm font-bold"
  }, "\uD83E\uDDE0 \u56DE\u590D\u5B57\u6570\u6863\u4F4D\u3001\u957F\u6587\u622A\u65AD\u9608\u503C\u4E0E\u7ED3\u8BBA\u7EAA\u8981"), /*#__PURE__*/React.createElement("p", {
    className: "text-[11px] opacity-60"
  }, "\u63A7\u5236 AI \u6BCF\u6B21\u56DE\u7B54\u7684\u957F\u77ED\u7BC7\u5E45\u3001\u8D85\u957F\u6D88\u606F\u8FC7\u6EE4\uFF08\u7F6E\u9876\u4E0E\u4EE3\u7801\u5757\u53EF\u7834\u9650\uFF09\uFF0C\u4EE5\u53CA\u81EA\u52A8\u7ED3\u8BBA\u5361")))), /*#__PURE__*/React.createElement("div", {
    className: `p-4 rounded-2xl border space-y-2.5 ${darkMode ? 'bg-black/30 border-white/10' : 'bg-white border-amber-200/70'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap items-center justify-between gap-2"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "text-xs font-bold"
  }, "\uD83D\uDCCF AI \u5355\u6B21\u56DE\u590D\u7BC7\u5E45\u5B57\u6570\u8F6F\u4E0A\u9650\uFF08\u6309\u573A\u666F\u5207\u6362\u77ED\u8BC4\u6216\u6DF1\u5EA6\u5206\u6790\uFF09"), /*#__PURE__*/React.createElement("div", {
    className: "text-[10px] opacity-60"
  }, "\u95F2\u804A\u4E92\u603C\u9002\u5408 50 \u5B57\u5185\u79D2\u56DE\uFF1B\u8BA8\u8BBA\u67B6\u6784\u65B9\u6848\u3001\u5199\u4EE3\u7801\u6216\u6DF1\u5EA6\u8BC4\u5BA1\u65F6\u53EF\u653E\u5BBD\u81F3 120~300 \u5B57\u6216\u4E0D\u9650"))), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-2 sm:grid-cols-4 gap-2"
  }, [{
    id: 'short-50',
    label: '⚡ 50字极简短评',
    desc: '1~2句口语互怼，吐字飞快'
  }, {
    id: 'medium-120',
    label: '💬 120字适中观点',
    desc: '2~4句把理由说透，不啰嗦'
  }, {
    id: 'deep-300',
    label: '📝 300字深度分析',
    desc: '适合方案评审与架构拆解'
  }, {
    id: 'unlimited',
    label: '♾️ 不限字数 (自由长文)',
    desc: '写完整代码或长篇报告时开启'
  }].map(mode => {
    const active = (featureSettings.replyLengthMode || 'short-50') === mode.id;
    return /*#__PURE__*/React.createElement("button", {
      key: mode.id,
      type: "button",
      onClick: () => setFeatureSettings(prev => ({
        ...prev,
        replyLengthMode: mode.id
      })),
      className: `p-2.5 rounded-xl border text-left transition-all ${active ? 'bg-amber-500 border-amber-500 text-white font-semibold shadow-xs' : darkMode ? 'bg-black/25 border-white/10 hover:bg-white/5' : 'bg-zinc-50 border-zinc-200 hover:bg-zinc-100'}`
    }, /*#__PURE__*/React.createElement("div", {
      className: "text-xs"
    }, mode.label), /*#__PURE__*/React.createElement("div", {
      className: `text-[9px] mt-0.5 ${active ? 'text-white/90' : 'opacity-60'}`
    }, mode.desc));
  }))), /*#__PURE__*/React.createElement("div", {
    className: `p-4 rounded-2xl border space-y-3 ${darkMode ? 'bg-black/30 border-white/10' : 'bg-white border-amber-200/70'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-between gap-2"
  }, /*#__PURE__*/React.createElement("h4", {
    className: "text-xs font-bold flex items-center gap-1.5"
  }, /*#__PURE__*/React.createElement(Pin, {
    className: "w-3.5 h-3.5 text-amber-500"
  }), /*#__PURE__*/React.createElement("span", null, "\u957F\u6D88\u606F\u589E\u91CF\u540C\u6B65\u8FC7\u6EE4\u9608\u503C\uFF08\u7F6E\u9876\u6D88\u606F & \u8F6C\u53D1\u6D88\u606F 100% \u7A81\u7834\u9650\u5236\uFF09")), /*#__PURE__*/React.createElement("span", {
    className: "text-[10px] font-mono text-amber-500 font-bold"
  }, featureSettings.maxContextChars ? `>${featureSettings.maxContextChars}字过滤` : '无限制')), /*#__PURE__*/React.createElement("p", {
    className: "text-[11px] opacity-65 leading-relaxed"
  }, "\u67D0\u4F4D AI \u53D1\u8A00\u8FC7\u957F\u5BB9\u6613\u6491\u7206\u5176\u4ED6 AI \u7684\u4E0A\u4E0B\u6587\u3002\u5355\u6761\u8D85\u8FC7\u8BBE\u5B9A\u5B57\u6570\u9ED8\u8BA4\u4E0D\u5411\u5176\u4ED6 AI \u540C\u6B65\uFF1B", /*#__PURE__*/React.createElement("b", null, "\u4F46\u53EA\u8981\u4E3B\u7406\u4EBA\u5C06\u8BE5\u6D88\u606F\u300C\u7F6E\u9876\u300D\u3001\u6216\u8005\u662F\u300C\u8DE8\u7FA4\u8F6C\u53D1\u6D88\u606F\u300D\uFF0C\u5219\u4EAB\u6709\u7279\u6743 100% \u5168\u91CF\u540C\u6B65\u7ED9\u6240\u6709\u4EBA\uFF01")), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap items-center gap-2"
  }, [{
    label: '300字',
    value: 300
  }, {
    label: '500字',
    value: 500
  }, {
    label: '800字 (推荐)',
    value: 800
  }, {
    label: '1200字',
    value: 1200
  }, {
    label: '不限制',
    value: 0
  }].map(item => {
    const active = Number(featureSettings.maxContextChars ?? 800) === item.value;
    return /*#__PURE__*/React.createElement("button", {
      key: item.label,
      type: "button",
      onClick: () => setFeatureSettings(prev => ({
        ...prev,
        maxContextChars: item.value
      })),
      className: `px-3 py-1.5 rounded-xl border text-[11px] font-medium transition-all ${active ? 'bg-amber-500 border-amber-500 text-white font-bold shadow-xs' : darkMode ? 'bg-black/20 border-white/10 hover:bg-white/5' : 'bg-zinc-50 border-zinc-200 hover:bg-zinc-100'}`
    }, item.label);
  }))), /*#__PURE__*/React.createElement("div", {
    className: "grid sm:grid-cols-3 gap-2.5"
  }, [['preserveCodeBlocks', '💻 代码块与报错日志免截断保护 (新增)', '即使开启了长消息过滤，只要消息包含代码块 (```) 或报错堆栈，自动放行同步给其他 AI 协同排查。'], ['conclusionCard', '📊 值守结束自动生成一页纸结论卡', '讨论轮数跑完或达成共识后，自动汇总「核心共识 / 关键分歧 / 落地建议」三栏结论卡。'], ['saveLocal', '💾 自动持久化保存在本地磁盘与浏览器', '群聊记录、各群独立游标、人设和主题实时写入本地，重启不丢失。']].map(([key, title, description]) => /*#__PURE__*/React.createElement("button", {
    key: key,
    type: "button",
    "aria-pressed": Boolean(featureSettings[key]),
    onClick: () => setFeatureSettings(previous => ({
      ...previous,
      [key]: !previous[key]
    })),
    className: `flex items-start gap-3 text-left p-3 rounded-2xl border transition-all ${featureSettings[key] ? darkMode ? 'bg-amber-500/15 border-amber-400/35 shadow-2xs' : 'bg-white border-amber-300 shadow-xs' : darkMode ? 'bg-black/25 border-white/[0.07] opacity-75' : 'bg-white/60 border-zinc-200/80 opacity-80'}`
  }, /*#__PURE__*/React.createElement("span", {
    className: `mt-0.5 w-8 h-[18px] rounded-full p-0.5 shrink-0 transition-colors ${featureSettings[key] ? 'bg-amber-500' : 'bg-zinc-400/50'}`
  }, /*#__PURE__*/React.createElement("span", {
    className: `block w-[14px] h-[14px] rounded-full bg-white shadow-sm transition-transform ${featureSettings[key] ? 'translate-x-[14px]' : ''}`
  })), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("span", {
    className: "block text-xs font-bold"
  }, title), /*#__PURE__*/React.createElement("span", {
    className: "block text-[10px] opacity-65 leading-relaxed mt-1"
  }, description)))))), (settingsCategoryTab === 'all' || settingsCategoryTab === 'safety') && /*#__PURE__*/React.createElement("section", {
    className: `p-4 sm:p-5 rounded-3xl border-2 space-y-4 ${darkMode ? 'bg-emerald-950/[0.12] border-emerald-500/25' : 'bg-emerald-50/40 border-emerald-200/80'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap items-center justify-between gap-2 pb-2.5 border-b border-emerald-500/15"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2.5"
  }, /*#__PURE__*/React.createElement("span", {
    className: "px-2.5 py-1 rounded-xl bg-emerald-600 text-white text-xs font-bold shadow-xs"
  }, "\u5206\u533A 04"), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h3", {
    className: "text-sm font-bold"
  }, "\uD83D\uDEE1\uFE0F \u7F51\u9875\u9632\u5C01\u53F7\u62A4\u680F\u4E0E\u6781\u901F\u6865\u63A5\u5F15\u64CE"), /*#__PURE__*/React.createElement("p", {
    className: "text-[11px] opacity-60"
  }, "\u4FDD\u62A4\u7B2C\u4E09\u65B9\u7F51\u9875 AI \u8D26\u53F7\u5B89\u5168\uFF0C\u6D88\u9664\u673A\u5668\u6307\u7EB9\uFF0C\u5904\u7406\u98CE\u63A7\u7194\u65AD\u3001\u7E41\u5FD9\u6392\u961F\u4E0E\u5355\u8D34\u8F6E\u6570\u4E0A\u9650")))), /*#__PURE__*/React.createElement("div", {
    className: "grid sm:grid-cols-2 gap-2.5"
  }, [['mergeIncrementalContext', '📦 合并增量上下文（消息打包防抖）', '将同一成员连续发言或多条未读合并为单次增量包发送，单账号请求频次降低 50%~70%。'], ['rotatePromptFingerprints', '🎭 动态轮换 Prompt 自然语言话术', '每次同步自动轮换多种日常群聊导语与收尾句，只在首轮或改人设后提醒设定，彻底消除固定机器指纹。'], ['circuitBreakOnRisk', '🛡️ 敏感报错与限流词主动熔断保护', '一旦检测到 Too many requests、Cloudflare、验证码或操作频繁提示，立即熔断暂停并提醒人工接管。'], ['queueWhileBusy', '⏳ 网页忙时自动合并排队消息', '同一网页正在流式输出时，新消息自动留在该群排队合并，等网页空闲后安全补发。'], ['firstSentenceHandoff', '⚡ 看到首句后提前唤醒下一位 AI', '当前网页吐出第一句后即刻并行准备下一位，加速长讨论衔接。'], ['skipStalledTab', '⏭️ 网页无响应 5 秒自动跳过防卡死', '若目标网页 5 秒未响应且未处于生成状态则自动顺延下一位，绝不死等卡住群聊。']].map(([key, title, description]) => /*#__PURE__*/React.createElement("button", {
    key: key,
    type: "button",
    "aria-pressed": Boolean(featureSettings[key]),
    onClick: () => setFeatureSettings(previous => ({
      ...previous,
      [key]: !previous[key]
    })),
    className: `flex items-start gap-3 text-left p-3 rounded-2xl border transition-all ${featureSettings[key] ? darkMode ? 'bg-emerald-500/15 border-emerald-400/35 shadow-2xs' : 'bg-white border-emerald-300 shadow-xs' : darkMode ? 'bg-black/25 border-white/[0.07] opacity-75' : 'bg-white/60 border-zinc-200/80 opacity-80'}`
  }, /*#__PURE__*/React.createElement("span", {
    className: `mt-0.5 w-8 h-[18px] rounded-full p-0.5 shrink-0 transition-colors ${featureSettings[key] ? 'bg-emerald-600' : 'bg-zinc-400/50'}`
  }, /*#__PURE__*/React.createElement("span", {
    className: `block w-[14px] h-[14px] rounded-full bg-white shadow-sm transition-transform ${featureSettings[key] ? 'translate-x-[14px]' : ''}`
  })), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("span", {
    className: "block text-xs font-bold"
  }, title), /*#__PURE__*/React.createElement("span", {
    className: "block text-[10px] opacity-65 leading-relaxed mt-1"
  }, description))))), /*#__PURE__*/React.createElement("div", {
    className: `p-4 rounded-2xl border space-y-3 ${darkMode ? 'bg-black/30 border-white/10' : 'bg-white border-emerald-200/70'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap items-center justify-between gap-2"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h4", {
    className: "text-xs font-bold tracking-wide"
  }, "\uD83D\uDD04 \u5355\u8D34\u5BF9\u8BDD\u8F6E\u6570\u5065\u5EB7\u4E0A\u9650\uFF08\u907F\u514D\u8D85\u957F\u5355\u8D34\u89E6\u53D1\u5E73\u53F0\u98CE\u63A7\u5BA1\u8BA1\uFF09"), /*#__PURE__*/React.createElement("p", {
    className: "text-[10px] opacity-60 mt-0.5"
  }, "\u5F53\u524D\u7FA4\u804A\u672C\u8D34\u5DF2\u7D2F\u8BA1\u56DE\u590D ", /*#__PURE__*/React.createElement("b", {
    className: "font-mono text-emerald-500"
  }, activeGroupState.sessionRounds || 0), " \u8F6E\u3002\u8FBE\u5230\u8BBE\u5B9A\u8F6E\u6570\u540E\u81EA\u52A8\u6682\u505C\u503C\u5B88\u5E76\u751F\u6210\u4E00\u9875\u7EB8\u7ED3\u8BBA\u5361\uFF0C\u65B9\u4FBF\u7C98\u8D34\u5230\u65B0\u7F51\u9875\u5BF9\u8BDD\u7EE7\u7EED\u804A\uFF1B\u8BBE\u4E3A ", /*#__PURE__*/React.createElement("b", null, "\u65E0\u9650\u5927 (\u221E)"), " \u5219\u6C38\u4E0D\u9650\u5236\u3002")), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => {
      updateGroupState(activeGroupId, state => ({
        ...state,
        sessionRounds: 0
      }));
      showToast('已清零当前群聊的累计对话轮数');
    },
    className: "px-2.5 py-1 rounded-lg border text-[10px] font-medium hover:bg-black/5 dark:hover:bg-white/10 shrink-0"
  }, "\u6E05\u96F6\u672C\u7FA4\u5DF2\u804A\u8F6E\u6570")), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap items-center gap-2"
  }, [{
    label: '30 轮',
    value: 30
  }, {
    label: '45 轮 (推荐)',
    value: 45
  }, {
    label: '60 轮',
    value: 60
  }, {
    label: '100 轮',
    value: 100
  }, {
    label: '∞ 无限大 (不限制)',
    value: 0
  }].map(preset => {
    const active = Number(featureSettings.maxSessionRounds || 0) === preset.value;
    return /*#__PURE__*/React.createElement("button", {
      key: preset.value,
      type: "button",
      onClick: () => setFeatureSettings(prev => ({
        ...prev,
        maxSessionRounds: preset.value
      })),
      className: `px-3 py-1.5 rounded-full text-[11px] font-medium border transition-all ${active ? 'bg-emerald-600 border-emerald-600 text-white shadow-2xs' : darkMode ? 'bg-black/30 border-white/10 text-zinc-300 hover:bg-white/10' : 'bg-zinc-50 border-zinc-200 text-zinc-700 hover:bg-zinc-100'}`
    }, preset.label);
  }), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-1.5 ml-auto"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-[11px] opacity-70"
  }, "\u81EA\u5B9A\u4E49\u8F6E\u6570\uFF1A"), /*#__PURE__*/React.createElement("input", {
    type: "number",
    min: 0,
    max: 9999,
    value: Number(featureSettings.maxSessionRounds || 0) === 0 ? '' : featureSettings.maxSessionRounds,
    placeholder: "\u221E \u65E0\u9650",
    onChange: e => {
      const raw = e.target.value.trim();
      const parsed = raw === '' ? 0 : Math.max(0, Math.floor(Number(raw) || 0));
      setFeatureSettings(prev => ({
        ...prev,
        maxSessionRounds: parsed
      }));
    },
    className: `w-24 px-2.5 py-1 rounded-xl border text-xs font-mono text-center ${darkMode ? 'bg-black/40 border-white/15 text-white' : 'bg-white border-zinc-200 text-zinc-900'}`
  }), /*#__PURE__*/React.createElement("span", {
    className: "text-[10px] opacity-55"
  }, "\uFF08\u586B 0 \u6216\u7559\u7A7A = \u221E\uFF09"))))), /*#__PURE__*/React.createElement("p", {
    className: "text-[10px] leading-relaxed opacity-50 px-1"
  }, "\u63D0\u793A\uFF1A\u672A\u8BFB\u89D2\u6807\u5F62\u72B6/\u5927\u5C0F/\u989C\u8272\u3001\u6025\u505C\u5706\u70B9\u989C\u8272\u53CA 28 \u6B3E\u51B7\u6696\u4E3B\u9898\u5DF2\u5F52\u7C7B\u81F3\u300C\u5916\u89C2\u4E0E\u5934\u50CF\u5B9A\u5236\u4E2D\u5FC3\u300D\uFF0C\u70B9\u51FB\u5F39\u7A97\u53F3\u4E0A\u89D2\u6309\u94AE\u5373\u53EF\u4E00\u952E\u524D\u5F80\u3002")), /*#__PURE__*/React.createElement("footer", {
    className: "px-5 py-3 border-t border-black/5 dark:border-white/10 flex justify-between items-center shrink-0"
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => {
      setFeatureSettings({
        ...DEFAULT_FEATURE_SETTINGS
      });
      showToast('已将所有系统设置恢复为推荐默认值');
    },
    className: "text-xs text-blue-500 hover:underline font-medium"
  }, "\u6062\u590D\u63A8\u8350\u9ED8\u8BA4\u8BBE\u7F6E"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => setSystemSettingsOpen(false),
    className: "px-5 py-2 rounded-xl bg-[#007AFF] hover:bg-blue-600 text-white text-xs font-semibold shadow-sm"
  }, "\u5B8C\u6210\u5E76\u4FDD\u5B58")))), groupEditorOpen && /*#__PURE__*/React.createElement("div", {
    className: "fixed inset-0 z-[100] bg-black/45 backdrop-blur-sm flex items-center justify-center p-4",
    onClick: () => setGroupEditorOpen(false)
  }, /*#__PURE__*/React.createElement("section", {
    onClick: event => event.stopPropagation(),
    className: `w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-3xl border p-5 shadow-2xl ${darkMode ? 'bg-zinc-900 border-white/10 text-zinc-100' : 'bg-white border-zinc-200 text-zinc-900'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-between mb-4"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h2", {
    className: "text-base font-bold"
  }, groupDraft.id ? '编辑群聊' : '新建群聊'), /*#__PURE__*/React.createElement("p", {
    className: "text-xs opacity-55 mt-1"
  }, "\u4E3A\u4E0D\u540C\u4E3B\u9898\u5EFA\u7ACB\u72EC\u7ACB\u6D88\u606F\u7A7A\u95F4\uFF0C\u5E76\u9009\u62E9\u7FA4\u804A\u6210\u5458\u3002")), /*#__PURE__*/React.createElement("button", {
    onClick: () => setGroupEditorOpen(false),
    className: "p-2 rounded-full opacity-60 hover:opacity-100"
  }, /*#__PURE__*/React.createElement(X, {
    className: "w-4 h-4"
  }))), /*#__PURE__*/React.createElement("label", {
    className: "block text-xs font-medium mb-1.5"
  }, "\u7FA4\u804A\u540D\u79F0"), /*#__PURE__*/React.createElement("input", {
    autoFocus: true,
    value: groupDraft.name,
    onChange: event => setGroupDraft(draft => ({
      ...draft,
      name: event.target.value
    })),
    placeholder: "\u4F8B\u5982\uFF1A\u4EA7\u54C1\u8111\u66B4\u7FA4",
    className: `w-full px-3 py-2.5 rounded-xl border text-sm mb-4 ${darkMode ? 'bg-black/30 border-white/10' : 'bg-zinc-50 border-zinc-200'}`
  }), /*#__PURE__*/React.createElement("div", {
    className: "text-xs font-semibold mb-2"
  }, "\u9009\u62E9\u7FA4\u804A\u6210\u5458\uFF08", groupDraft.memberIds.length, "\uFF09"), /*#__PURE__*/React.createElement("div", {
    className: "space-y-1.5 max-h-64 overflow-y-auto"
  }, bots.map(bot => /*#__PURE__*/React.createElement("label", {
    key: bot.id,
    className: `flex items-center gap-2.5 p-2.5 rounded-xl cursor-pointer ${darkMode ? 'hover:bg-white/5' : 'hover:bg-zinc-50'}`
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: groupDraft.memberIds.includes(bot.id),
    onChange: event => setGroupDraft(draft => ({
      ...draft,
      memberIds: event.target.checked ? [...new Set([...draft.memberIds, bot.id])] : draft.memberIds.filter(id => id !== bot.id)
    }))
  }), renderEntityAvatar(bot, 'w-7 h-7', 'text-[9px]'), /*#__PURE__*/React.createElement("span", {
    className: "text-xs font-medium"
  }, bot.name), /*#__PURE__*/React.createElement("span", {
    className: "text-[10px] opacity-50 ml-auto"
  }, bot.platform, " \xB7 ", bot.roleTag))), bots.length === 0 && /*#__PURE__*/React.createElement("div", {
    className: "text-xs opacity-50 p-3"
  }, "\u5148\u6DFB\u52A0 AI \u804A\u5929\u4EBA\uFF0C\u518D\u5C06\u5176\u52A0\u5165\u7FA4\u804A\u3002")), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-between gap-2 mt-5"
  }, groupDraft.id ? /*#__PURE__*/React.createElement("button", {
    onClick: () => setConfirmModalState({
      title: '删除群聊确认',
      message: '确定删除此群聊及其本地聊天记录吗？',
      onConfirm: () => deleteGroup(groupDraft.id)
    }),
    className: "px-3 py-2 rounded-xl text-xs text-rose-500 hover:bg-rose-500/10 flex items-center gap-1"
  }, /*#__PURE__*/React.createElement(Trash2, {
    className: "w-3.5 h-3.5"
  }), "\u5220\u9664\u7FA4\u804A") : /*#__PURE__*/React.createElement("span", null), /*#__PURE__*/React.createElement("div", {
    className: "flex gap-2"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setGroupEditorOpen(false),
    className: `px-3.5 py-2 rounded-xl text-xs ${darkMode ? 'bg-white/5 hover:bg-white/10' : 'bg-zinc-100 hover:bg-zinc-200'}`
  }, "\u53D6\u6D88"), /*#__PURE__*/React.createElement("button", {
    onClick: saveGroup,
    className: "px-4 py-2 rounded-xl bg-[#007AFF] text-white text-xs font-semibold"
  }, "\u4FDD\u5B58\u7FA4\u804A"))))), botEditorOpen && /*#__PURE__*/React.createElement("div", {
    className: "fixed inset-0 z-[100] bg-black/45 backdrop-blur-sm flex items-center justify-center p-4",
    onClick: () => setBotEditorOpen(false)
  }, /*#__PURE__*/React.createElement("section", {
    onClick: event => event.stopPropagation(),
    className: `w-full max-w-xl max-h-[88vh] overflow-y-auto rounded-3xl border p-5 shadow-2xl ${darkMode ? 'bg-zinc-900 border-white/10 text-zinc-100' : 'bg-white border-zinc-200 text-zinc-900'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-between mb-4"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h2", {
    className: "text-base font-bold"
  }, "\u65B0\u5EFA AI \u804A\u5929\u4EBA"), /*#__PURE__*/React.createElement("p", {
    className: "text-xs opacity-55 mt-1"
  }, "\u9009\u62E9\u7F51\u9875 AI\uFF0C\u6216\u590D\u5236\u5DF2\u6709\u804A\u5929\u4EBA\u7684\u8FDE\u63A5\u548C\u4EBA\u8BBE\uFF0C\u518D\u52A0\u5165\u5F53\u524D\u7FA4\u804A\u3002")), /*#__PURE__*/React.createElement("button", {
    onClick: () => setBotEditorOpen(false),
    className: "p-2 rounded-full opacity-60 hover:opacity-100"
  }, /*#__PURE__*/React.createElement(X, {
    className: "w-4 h-4"
  }))), /*#__PURE__*/React.createElement("label", {
    className: "block text-xs font-medium mb-1.5"
  }, "\u9009\u62E9 AI / \u590D\u7528\u65E7\u804A\u5929\u4EBA"), /*#__PURE__*/React.createElement("select", {
    value: botDraft.templateId ? `copy:${botDraft.templateId}` : botDraft.platform,
    onChange: event => {
      const value = event.target.value;
      const template = value.startsWith('copy:') ? bots.find(bot => bot.id === value.slice(5)) : null;
      const providerDefaults = {
        'ChatGPT': ['#prompt-textarea', 'button[data-testid="send-button"]', 'https://chatgpt.com/'],
        'Claude': ['div.ProseMirror[contenteditable="true"]', 'button[aria-label="Send Message"]', 'https://claude.ai/new'],
        'DeepSeek': ['#chat-input', 'div[role="button"].ds-send-btn', 'https://chat.deepseek.com/'],
        'Kimi': ['div[contenteditable="true"].chat-input', 'button.send-button', 'https://www.kimi.com/'],
        'Gemini': ['rich-textarea [contenteditable="true"]', 'button[data-test-id="send-button"]', 'https://gemini.google.com/app'],
        '豆包': ['[contenteditable="true"]', 'button[aria-label*="发送"]', 'https://www.doubao.com/chat/'],
        '千问': ['[contenteditable="true"]', 'button[aria-label*="发送"]', 'https://chat.qwen.ai/'],
        '自定义网页 AI': ['div[contenteditable="true"]', 'button[type="submit"]', '']
      }[value] || ['div[contenteditable="true"]', 'button[type="submit"]', ''];
      setBotDraft(template ? {
        templateId: template.id,
        name: `${template.name} 新成员`,
        roleTag: template.roleTag,
        platform: template.platform,
        targetUrl: template.targetUrl,
        selectorInput: template.selectorInput,
        selectorSend: template.selectorSend,
        persona: template.persona,
        badge: template.badge
      } : {
        ...botDraft,
        templateId: '',
        platform: value,
        targetUrl: providerDefaults[2],
        selectorInput: providerDefaults[0],
        selectorSend: providerDefaults[1]
      });
    },
    className: `w-full px-3 py-2.5 rounded-xl border text-sm mb-4 ${darkMode ? 'bg-black/30 border-white/10' : 'bg-zinc-50 border-zinc-200'}`
  }, /*#__PURE__*/React.createElement("option", {
    value: "ChatGPT"
  }, "ChatGPT"), /*#__PURE__*/React.createElement("option", {
    value: "Claude"
  }, "Claude"), /*#__PURE__*/React.createElement("option", {
    value: "DeepSeek"
  }, "DeepSeek"), /*#__PURE__*/React.createElement("option", {
    value: "Kimi"
  }, "Kimi"), /*#__PURE__*/React.createElement("option", {
    value: "Gemini"
  }, "Gemini"), /*#__PURE__*/React.createElement("option", {
    value: "豆包"
  }, "豆包"), /*#__PURE__*/React.createElement("option", {
    value: "千问"
  }, "千问"), /*#__PURE__*/React.createElement("option", {
    value: "\u81EA\u5B9A\u4E49\u7F51\u9875 AI"
  }, "\u81EA\u5B9A\u4E49\u7F51\u9875 AI"), bots.length > 0 && /*#__PURE__*/React.createElement("optgroup", {
    label: "\u590D\u5236\u73B0\u6709\u804A\u5929\u4EBA"
  }, bots.map(bot => /*#__PURE__*/React.createElement("option", {
    key: bot.id,
    value: `copy:${bot.id}`
  }, bot.name, " \xB7 ", bot.platform)))), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-1 sm:grid-cols-2 gap-3"
  }, /*#__PURE__*/React.createElement("label", {
    className: "text-xs font-medium"
  }, "\u7FA4\u804A\u6635\u79F0", /*#__PURE__*/React.createElement("input", {
    value: botDraft.name,
    onChange: event => setBotDraft(draft => ({
      ...draft,
      name: event.target.value
    })),
    placeholder: "\u7ED9\u804A\u5929\u4EBA\u8D77\u4E2A\u540D\u5B57",
    className: `mt-1.5 w-full px-3 py-2 rounded-xl border text-sm ${darkMode ? 'bg-black/30 border-white/10' : 'bg-zinc-50 border-zinc-200'}`
  })), /*#__PURE__*/React.createElement("label", {
    className: "text-xs font-medium"
  }, "\u8EAB\u4EFD\u6807\u7B7E", /*#__PURE__*/React.createElement("input", {
    value: botDraft.roleTag,
    onChange: event => setBotDraft(draft => ({
      ...draft,
      roleTag: event.target.value
    })),
    placeholder: "\u4F8B\u5982\uFF1A\u4EA7\u54C1\u7ECF\u7406",
    className: `mt-1.5 w-full px-3 py-2 rounded-xl border text-sm ${darkMode ? 'bg-black/30 border-white/10' : 'bg-zinc-50 border-zinc-200'}`
  }))), !botDraft.templateId && /*#__PURE__*/React.createElement("label", {
    className: "block text-xs font-medium mt-3"
  }, "\u7F51\u9875\u5BF9\u8BDD\u5730\u5740", /*#__PURE__*/React.createElement("input", {
    value: botDraft.targetUrl,
    onChange: event => setBotDraft(draft => ({
      ...draft,
      targetUrl: event.target.value
    })),
    placeholder: "\u53EF\u5148\u7559\u7A7A\uFF0C\u4E4B\u540E\u5728\u7F51\u9875\u7ED1\u5B9A\u9875\u8865\u5145",
    className: `mt-1.5 w-full px-3 py-2 rounded-xl border text-xs font-mono ${darkMode ? 'bg-black/30 border-white/10' : 'bg-zinc-50 border-zinc-200'}`
  })), /*#__PURE__*/React.createElement("label", {
    className: "block text-xs font-medium mt-3"
  }, "\u80CC\u666F\u63D0\u793A\u8BCD / \u4EBA\u8BBE", /*#__PURE__*/React.createElement("textarea", {
    rows: 4,
    value: botDraft.persona,
    onChange: event => setBotDraft(draft => ({
      ...draft,
      persona: event.target.value
    })),
    placeholder: "\u63CF\u8FF0\u8FD9\u4E2A\u804A\u5929\u4EBA\u5982\u4F55\u601D\u8003\u3001\u4EE5\u4EC0\u4E48\u53E3\u543B\u53C2\u4E0E\u7FA4\u804A\uFF1B\u4F1A\u968F\u589E\u91CF\u4E0A\u4E0B\u6587\u53D1\u7ED9\u5BF9\u5E94\u7F51\u9875 AI\u3002",
    className: `mt-1.5 w-full px-3 py-2.5 rounded-xl border text-sm leading-relaxed ${darkMode ? 'bg-black/30 border-white/10' : 'bg-zinc-50 border-zinc-200'}`
  })), /*#__PURE__*/React.createElement("div", {
    className: "flex justify-end gap-2 mt-5"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setBotEditorOpen(false),
    className: `px-3.5 py-2 rounded-xl text-xs ${darkMode ? 'bg-white/5 hover:bg-white/10' : 'bg-zinc-100 hover:bg-zinc-200'}`
  }, "\u53D6\u6D88"), /*#__PURE__*/React.createElement("button", {
    onClick: saveBot,
    className: "px-4 py-2 rounded-xl bg-[#007AFF] text-white text-xs font-semibold"
  }, "\u521B\u5EFA\u5E76\u52A0\u5165\u5F53\u524D\u7FA4\u804A"))))), confirmModalState && /*#__PURE__*/React.createElement("div", {
    className: "fixed inset-0 z-[150] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4",
    onClick: () => setConfirmModalState(null)
  }, /*#__PURE__*/React.createElement("div", {
    onClick: e => e.stopPropagation(),
    className: `w-full max-w-sm rounded-3xl border p-5 shadow-2xl space-y-4 ${darkMode ? 'bg-zinc-900 border-white/10 text-white' : 'bg-white border-zinc-200 text-zinc-900'}`
  }, /*#__PURE__*/React.createElement("h3", {
    className: "text-sm font-bold"
  }, confirmModalState.title), /*#__PURE__*/React.createElement("p", {
    className: "text-xs opacity-70 leading-relaxed"
  }, confirmModalState.message), /*#__PURE__*/React.createElement("div", {
    className: "flex justify-end gap-2"
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => setConfirmModalState(null),
    className: `px-3.5 py-1.5 rounded-xl text-xs font-medium ${darkMode ? 'bg-white/10 hover:bg-white/15' : 'bg-zinc-100 hover:bg-zinc-200'}`
  }, "\u53D6\u6D88"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => {
      confirmModalState.onConfirm?.();
      setConfirmModalState(null);
    },
    className: "px-4 py-1.5 rounded-xl bg-rose-500 hover:bg-rose-600 text-white text-xs font-semibold"
  }, "\u786E\u8BA4")))), toast && /*#__PURE__*/React.createElement("div", {
    role: "status",
    "aria-live": "polite",
    className: "sr-only"
  }, toast)));
}
window.App = App;

function __mountWebH() {
  const rootEl = document.getElementById('root');
  if (rootEl && window.App) {
    window.ReactDOMClient.createRoot(rootEl).render(
      window.React.createElement(window.App, null)
    );
  }
}
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', __mountWebH);
} else {
  __mountWebH();
}
