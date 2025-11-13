import { promises as fs } from 'fs';
import axios, { AxiosResponse } from 'axios';

interface NetworkComponent {
  id: string;
}

interface ComponentsData {
  pageId: string;
  networks: Record<string, NetworkComponent>;
}

interface ComponentInfo {
  id: string;
  pageId: string;
}

interface ComponentUpdate {
  name: string;
  status: 'OPERATIONAL' | 'PARTIALOUTAGE';
  grouped: boolean;
}

interface IncidentResponse {
  [key: string]: any;
}

const apiKey: string = process.env.INSTATUS_API_KEY || "";

/**
 * Reads the categorized JSON file containing component information
 * @param filePath - Path to the JSON file
 * @returns Promise resolving to the parsed components data
 */
async function readComponentsFromFile(filePath: string): Promise<ComponentsData> {
  try {
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data) as ComponentsData;
  } catch (err) {
    const error = err as Error;
    console.error('Error reading the JSON file:', error.message);
    throw err;
  }
}

/**
 * Gets component ID and pageId by network name
 * All scheduler types (vesting, flow, wrap) share the same component ID per network
 * @param networkName - Name of the network
 * @param type - Type of the component (wrap_scheduler, vesting_scheduler, flow_scheduler) - used for logging only
 * @returns Promise resolving to component info
 */
async function getComponentInfo(networkName: string, type: string): Promise<ComponentInfo> {
  const filePath = './instatus-components.json';
  
  try {
    const components = await readComponentsFromFile(filePath);
    
    if (!components.networks[networkName]) {
      throw new Error(`Network ${networkName} not found in components`);
    }
    
    return {
      id: components.networks[networkName].id,
      pageId: components.pageId
    };
  } catch (err) {
    const error = err as Error;
    console.error('Error getting component info:', error.message);
    throw err;
  }
}

/**
 * Updates component status to healthy (operational)
 * @param networkName - Name of the network
 * @param type - Type of the component (used for logging only)
 * @returns Promise resolving to the component update response
 */
async function createIncidentHealthy(networkName: string, type: string): Promise<IncidentResponse | undefined> {
  try {
    const componentInfo = await getComponentInfo(networkName, type);
    const url = `https://api.instatus.com/v2/${componentInfo.pageId}/components/${componentInfo.id}`;
    
    const componentData: ComponentUpdate = {
      name: `${networkName} Scheduler`,
      status: "OPERATIONAL",
      grouped: true
    };

    console.log(`[Instatus] Updating component "${componentData.name}" (ID: ${componentInfo.id}) to OPERATIONAL for network ${networkName} (type: ${type})`);

    const response: AxiosResponse<IncidentResponse> = await axios.put(url, componentData, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      }
    });
    
    console.log(`[Instatus] ✓ Successfully updated component ${componentInfo.id} to OPERATIONAL for network ${networkName}`);
    return response.data;
  } catch (err) {
    const axiosError = err as any;
    console.error(`[Instatus] ✗ Failed to update component to OPERATIONAL for network ${networkName} (type: ${type}):`, 
      axiosError.response?.data || axiosError.message);
    if (axiosError.response?.data) {
      console.error(`[Instatus] Error details:`, JSON.stringify(axiosError.response.data, null, 2));
    }
    if (axiosError.response?.config) {
      console.error(`[Instatus] Request URL: ${axiosError.response.config.url}`);
    }
    return undefined;
  }
}

/**
 * Updates component status to unhealthy (partial_outage)
 * @param networkName - Name of the network
 * @param type - Type of the component (used for logging only)
 * @returns Promise resolving to the component update response
 */
async function createIncidentUnhealthy(networkName: string, type: string): Promise<IncidentResponse | undefined> {
  try {
    const componentInfo = await getComponentInfo(networkName, type);
    const url = `https://api.instatus.com/v2/${componentInfo.pageId}/components/${componentInfo.id}`;
    
    const componentData: ComponentUpdate = {
      name: `${networkName} Scheduler`,
      status: "PARTIALOUTAGE",
      grouped: true
    };

    console.log(`[Instatus] Updating component "${componentData.name}" (ID: ${componentInfo.id}) to PARTIALOUTAGE for network ${networkName} (type: ${type})`);

    const response: AxiosResponse<IncidentResponse> = await axios.put(url, componentData, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      }
    });
    
    console.log(`[Instatus] ✓ Successfully updated component ${componentInfo.id} to PARTIALOUTAGE for network ${networkName}`);
    return response.data;
  } catch (err) {
    const axiosError = err as any;
    console.error(`[Instatus] ✗ Failed to update component to PARTIALOUTAGE for network ${networkName} (type: ${type}):`, 
      axiosError.response?.data || axiosError.message);
    if (axiosError.response?.data) {
      console.error(`[Instatus] Error details:`, JSON.stringify(axiosError.response.data, null, 2));
    }
    if (axiosError.response?.config) {
      console.error(`[Instatus] Request URL: ${axiosError.response.config.url}`);
    }
    return undefined;
  }
}

export {
  createIncidentHealthy,
  createIncidentUnhealthy
};
