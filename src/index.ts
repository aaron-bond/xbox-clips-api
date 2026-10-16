import { createApp } from './app';
import { OpenXblProvider } from './provider/openxbl';

export default createApp({ provider: new OpenXblProvider() });
