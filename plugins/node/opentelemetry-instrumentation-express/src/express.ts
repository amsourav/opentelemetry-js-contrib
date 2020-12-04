/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { hrTime } from '@opentelemetry/core';
import { Attributes } from '@opentelemetry/api';
import * as express from 'express';
import * as core from 'express-serve-static-core';
import {
  ExpressLayer,
  ExpressRouter,
  AttributeNames,
  PatchedRequest,
  Parameters,
  PathParams,
  _LAYERS_STORE_PROPERTY,
  ExpressInstrumentationConfig,
  ExpressLayerType,
} from './types';
import { getLayerMetadata, storeLayerPath, isLayerIgnored } from './utils';
import { VERSION } from './version';
import {
  isWrapped,
  InstrumentationBase,
  InstrumentationNodeModuleDefinition,
} from '@opentelemetry/instrumentation';

/**
 * This symbol is used to mark express layer as being already instrumented
 * since its possible to use a given layer multiple times (ex: middlewares)
 */
export const kLayerPatched: unique symbol = Symbol('express-layer-patched');

/** Express instrumentation plugin for OpenTelemetry */
export class ExpressInstrumentation extends InstrumentationBase<
  typeof express
> {
  static readonly component = 'express';

  constructor(config: ExpressInstrumentationConfig = {}) {
    super(
      '@opentelemetry/instrumentation-express',
      VERSION,
      Object.assign({}, config)
    );
  }

  setConfig(config: ExpressInstrumentationConfig = {}) {
    this._config = Object.assign({}, config);
  }

  protected init() {
    return new InstrumentationNodeModuleDefinition<typeof express>(
      'express',
      ['^4.0.0'],
      this.patch.bind(this),
      this.unpatch.bind(this)
    );
  }

  /**
   * Patches Express operations.
   */
  protected patch(moduleExports: typeof express) {
    this._logger.debug('Patching Express');

    if (moduleExports === undefined || moduleExports === null) {
      return moduleExports;
    }
    const routerProto = (moduleExports.Router as unknown) as express.Router;

    if (isWrapped(routerProto.route)) {
      this._unwrap(routerProto, 'route');
    }

    this._logger.debug('patching express.Router.prototype.route');
    this._wrap(routerProto, 'route', this._getRoutePatch.bind(this));

    if (isWrapped(routerProto.use)) {
      this._unwrap(routerProto, 'use');
    }

    this._logger.debug('patching express.Router.prototype.use');
    this._wrap(routerProto, 'use', this._getRouterUsePatch.bind(this));

    if (isWrapped(moduleExports.application.use)) {
      this._unwrap(moduleExports.application, 'use');
    }

    this._logger.debug('patching express.Application.use');
    this._wrap(
      moduleExports.application,
      'use',
      this._getAppUsePatch.bind(this)
    );

    return moduleExports;
  }

  /** Unpatches all Express patched functions. */
  protected unpatch(moduleExports: typeof express): void {
    if (moduleExports === undefined) return;
    const routerProto = (moduleExports.Router as unknown) as express.Router;
    this._unwrap(routerProto, 'use');
    this._unwrap(routerProto, 'route');
    this._unwrap(moduleExports.application, 'use');
  }

  /**
   * Get the patch for Router.route function
   * @param original
   */
  private _getRoutePatch(original: (path: PathParams) => express.IRoute) {
    const plugin = this;
    return function route_trace(
      this: ExpressRouter,
      ...args: Parameters<typeof original>
    ) {
      const route = original.apply(this, args);
      const layer = this.stack[this.stack.length - 1] as ExpressLayer;
      plugin._applyPatch(
        layer,
        typeof args[0] === 'string' ? args[0] : undefined
      );
      return route;
    };
  }

  /**
   * Get the patch for Router.use function
   * @param original
   */
  private _getRouterUsePatch(
    original: express.IRouterHandler<express.Router> &
      express.IRouterMatcher<express.Router>
  ) {
    const plugin = this;
    return function use(
      this: express.Application,
      ...args: Parameters<typeof original>
    ) {
      const route = original.apply(this, args);
      const layer = this.stack[this.stack.length - 1] as ExpressLayer;
      plugin._applyPatch(
        layer,
        typeof args[0] === 'string' ? args[0] : undefined
      );
      return route;
      // tslint:disable-next-line:no-any
    } as any;
  }

  /**
   * Get the patch for Application.use function
   * @param original
   */
  private _getAppUsePatch(
    original: core.ApplicationRequestHandler<express.Application>
  ) {
    const plugin = this;
    return function use(
      this: { _router: ExpressRouter },
      ...args: Parameters<typeof original>
    ) {
      const route = original.apply(this, args);
      const layer = this._router.stack[this._router.stack.length - 1];
      plugin._applyPatch(
        layer,
        typeof args[0] === 'string' ? args[0] : undefined
      );
      return route;
      // tslint:disable-next-line:no-any
    } as any;
  }

  /** Patch each express layer to create span and propagate context */
  private _applyPatch(layer: ExpressLayer, layerPath?: string) {
    const plugin = this;
    if (layer[kLayerPatched] === true) return;
    layer[kLayerPatched] = true;
    this._logger.debug('patching express.Router.Layer.handle');
    this._wrap(layer, 'handle', (original: Function) => {
      if (original.length === 4) return original;

      return function (
        this: ExpressLayer,
        req: PatchedRequest,
        res: express.Response,
        next: express.NextFunction
      ) {
        storeLayerPath(req, layerPath);
        const route = (req[_LAYERS_STORE_PROPERTY] as string[])
          .filter(path => path !== '/')
          .join('');
        const attributes: Attributes = {
          [AttributeNames.COMPONENT]: ExpressInstrumentation.component,
          [AttributeNames.HTTP_ROUTE]: route.length > 0 ? route : undefined,
        };
        const metadata = getLayerMetadata(layer, layerPath);
        const type = metadata.attributes[
          AttributeNames.EXPRESS_TYPE
        ] as ExpressLayerType;
        // verify against the config if the layer should be ignored
        if (isLayerIgnored(metadata.name, type, plugin._config)) {
          return original.apply(this, arguments);
        }
        if (plugin.tracer.getCurrentSpan() === undefined) {
          return original.apply(this, arguments);
        }
        // Rename the root http span once we reach the request handler
        if (
          metadata.attributes[AttributeNames.EXPRESS_TYPE] ===
          ExpressLayerType.REQUEST_HANDLER
        ) {
          const parent = plugin.tracer.getCurrentSpan();
          if (parent) {
            parent.updateName(`${req.method} ${route}`);
          }
        }
        const span = plugin.tracer.startSpan(metadata.name, {
          attributes: Object.assign(attributes, metadata.attributes),
        });
        const startTime = hrTime();
        let spanHasEnded = false;
        // If we found anything that isnt a middleware, there no point of measuring
        // their time since they dont have callback.
        if (
          metadata.attributes[AttributeNames.EXPRESS_TYPE] !==
          ExpressLayerType.MIDDLEWARE
        ) {
          span.end(startTime);
          spanHasEnded = true;
        }
        // listener for response.on('finish')
        const onResponseFinish = () => {
          if (spanHasEnded === false) {
            spanHasEnded = true;
            span.end(startTime);
          }
        };
        // verify we have a callback
        const args = Array.from(arguments);
        const callbackIdx = args.findIndex(arg => typeof arg === 'function');
        if (callbackIdx >= 0) {
          arguments[callbackIdx] = function () {
            if (spanHasEnded === false) {
              spanHasEnded = true;
              req.res?.removeListener('finish', onResponseFinish);
              span.end();
            }
            if (!(req.route && arguments[0] instanceof Error)) {
              (req[_LAYERS_STORE_PROPERTY] as string[]).pop();
            }
            const callback = args[callbackIdx] as Function;
            return plugin.tracer.bind(callback).apply(this, arguments);
          };
        }
        const result = original.apply(this, arguments);
        /**
         * At this point if the callback wasn't called, that means either the
         * layer is asynchronous (so it will call the callback later on) or that
         * the layer directly end the http response, so we'll hook into the "finish"
         * event to handle the later case.
         */
        req.res?.once('finish', onResponseFinish);
        return result;
      };
    });
  }
}
