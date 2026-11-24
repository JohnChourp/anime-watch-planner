import { bootstrapApplication } from '@angular/platform-browser';
import {
  RouteReuseStrategy,
  provideRouter,
  withComponentInputBinding,
  withPreloading,
  PreloadAllModules,
} from '@angular/router';
import { IonicRouteStrategy, provideIonicAngular } from '@ionic/angular';

import { AppComponent } from './app/app.component';
import { routes } from './app/app.routes';

bootstrapApplication(AppComponent, {
  providers: [
    { provide: RouteReuseStrategy, useClass: IonicRouteStrategy },
    // Honour the system "reduce motion" setting for Ionic's own page and modal transitions too.
    provideIonicAngular({ animated: !window.matchMedia('(prefers-reduced-motion: reduce)').matches }),
    provideRouter(routes, withPreloading(PreloadAllModules), withComponentInputBinding()),
  ],
});
