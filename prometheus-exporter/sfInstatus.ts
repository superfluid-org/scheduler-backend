import { promises as fs } from 'fs';
import axios, { AxiosResponse } from 'axios';

// Type definitions for the component data structure
interface NetworkComponent {
  id: string;
}

interface ComponentType {
  pageId: string;
  networks: Record<string, NetworkComponent>;
}

interface ComponentsData {
  [type: string]: ComponentType;
}

interface ComponentInfo {
  id: string;
  pageId: string;
}

interface IncidentData {
  name: string;
  message: string;
  status: 'OPERATIONAL' | 'PARTIALOUTAGE';
  components: string[];
}

interface IncidentResponse {
  // Define the response structure based on your needs
  [key: string]: any;
}

// Environment variable for API key
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
 * Gets component ID and pageId by network name and type
 * @param networkName - Name of the network
 * @param type - Type of the component (wrap_scheduler, vesting_scheduler, flow_scheduler)
 * @returns Promise resolving to component info
 */
async function getComponentInfo(networkName: string, type: string): Promise<ComponentInfo> {
  const filePath = './instatus-components.json';
  
  try {
    const components = await readComponentsFromFile(filePath);
    
    if (!components[type]) {
      throw new Error(`Type ${type} not found in components`);
    }
    
    if (!components[type].networks[networkName]) {
      throw new Error(`Network ${networkName} not found in type ${type}`);
    }
    
    return {
      id: components[type].networks[networkName].id,
      pageId: components[type].pageId
    };
  } catch (err) {
    const error = err as Error;
    console.error('Error getting component info:', error.message);
    throw err;
  }
}

/**
 * Creates an incident for a healthy component
 * @param networkName - Name of the network
 * @param type - Type of the component
 * @returns Promise resolving to the incident response
 */
async function createIncidentHealthy(networkName: string, type: string): Promise<IncidentResponse | undefined> {
  try {
    const componentInfo = await getComponentInfo(networkName, type);
    const url = `https://api.instatus.com/v1/${componentInfo.pageId}/components/${componentInfo.id}`;
    
    const incidentData: IncidentData = {
      name: `${networkName} Protocol Subgraph`,
      message: `Network ${networkName} is healthy.`,
      status: "OPERATIONAL",
      components: [componentInfo.id]
    };

    const response: AxiosResponse<IncidentResponse> = await axios.put(url, incidentData, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      }
    });
    
    console.log(`Created healthy incident for component ${componentInfo.id} and network ${networkName} (${type})`);
    return response.data;
  } catch (err) {
    const axiosError = err as any;
    console.error(`Error creating healthy incident for network ${networkName}-${type}:`, 
      axiosError.response ? axiosError.response.data : axiosError.message);
    return undefined;
  }
}

/**
 * Creates an incident for an unhealthy component
 * @param networkName - Name of the network
 * @param type - Type of the component
 * @returns Promise resolving to the incident response
 */
async function createIncidentUnhealthy(networkName: string, type: string): Promise<IncidentResponse | undefined> {
  try {
    const componentInfo = await getComponentInfo(networkName, type);
    const url = `https://api.instatus.com/v1/${componentInfo.pageId}/components/${componentInfo.id}`;
    
    const incidentData: IncidentData = {
      name: `${networkName} Protocol Subgraph`,
      message: `Network ${networkName} is experiencing issues.`,
      status: "PARTIALOUTAGE",
      components: [componentInfo.id]
    };

    const response: AxiosResponse<IncidentResponse> = await axios.put(url, incidentData, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      }
    });
    
    console.log(`Created unhealthy incident for component ${componentInfo.id} and network ${networkName} (${type})`);
    return response.data;
  } catch (err) {
    const axiosError = err as any;
    console.error(`Error creating unhealthy incident for network ${networkName}-${type}:`, 
      axiosError.response ? axiosError.response.data : axiosError.message);
    return undefined;
  }
}

// Export functions using ES module syntax
export {
  createIncidentHealthy,
  createIncidentUnhealthy,
  getComponentInfo,
  readComponentsFromFile
};

// Export types for use in other files
export type {
  ComponentInfo,
  IncidentData,
  IncidentResponse,
  ComponentsData,
  ComponentType,
  NetworkComponent
};
